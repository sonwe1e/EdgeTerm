import { create } from "zustand";
import { errorInfo } from "../errorInfo";
import {
  WORKBENCH_EXPERIMENTS_KEY,
  WORKBENCH_LAST_PROJECT_KEY,
  WORKBENCH_OPEN_FILES_KEY,
  WORKBENCH_VIEW_KEY,
} from "../persistKeys";
import { t } from "../i18n";
import { useStore } from "../store";
import { connectedTabFor, ensureSessionFor, openWorkspaceTerminal } from "./session";
import { forgetEditorState } from "./editorState";
import * as wb from "./api";
import {
  cachedDraft,
  cachedDrafts,
  draftBytes,
  draftDirectory,
  draftKey,
  draftLoadError,
  draftUnreadable,
  ensureDraftsLoaded,
  importLegacyDrafts,
  reloadDrafts,
  removeDraft,
  saveDraft,
} from "./drafts";
import type { Draft } from "./draftTypes";
import {
  defaultCommand,
  draftRun,
  experimentRoot,
  experimentsOf,
  runsOf,
  serverKey,
  serverLabel,
} from "./model";
import type {
  EditorDoc,
  ExecutionMode,
  Experiment,
  FileList,
  GitState,
  ProjectProbe,
  RunRecord,
  SnapshotMode,
  Workspace,
  WorkspaceCommand,
  WorkspaceData,
} from "./types";
const VIEW_STORAGE_KEY = WORKBENCH_VIEW_KEY;
const LAST_WORKSPACE_KEY = WORKBENCH_LAST_PROJECT_KEY;
const EXPERIMENT_MEMORY_KEY = WORKBENCH_EXPERIMENTS_KEY;
const OPEN_FILES_KEY = WORKBENCH_OPEN_FILES_KEY;

/** Open documents kept in memory; saved ones are released first. */
const MAX_DOCS = 8;
const HARD_MAX_DOCS = 16;
const MAX_DOC_CHARS = 8_000_000;
/** Listings and git states are views, not records: keep a few, not all. */
const VIEW_CACHE_LIMIT = 8;

type View = "terminals" | "workbench";
type Status = "idle" | "loading" | "ready" | "error";

const now = () => Date.now();


function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function boundedView<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): Record<string, T> {
  const next = { ...record, [key]: value };
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - VIEW_CACHE_LIMIT))) {
    delete next[stale];
  }
  return next;
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full storage only costs the view's remembered context.
  }
}

function readView(): View {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "workbench" ? "workbench" : "terminals";
  } catch {
    return "terminals";
  }
}

interface OpenFileMemory {
  workspaceId: string;
  experimentId: string;
  path: string;
}

const openFiles = (): OpenFileMemory[] => {
  const value = readJson<unknown>(OPEN_FILES_KEY, []);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is OpenFileMemory =>
      Boolean(entry) &&
      typeof (entry as OpenFileMemory).workspaceId === "string" &&
      typeof (entry as OpenFileMemory).experimentId === "string" &&
      typeof (entry as OpenFileMemory).path === "string",
  );
};

function rememberOpenFiles(docs: EditorDoc[]): void {
  writeJson(
    OPEN_FILES_KEY,
    docs.map((doc) => ({
      workspaceId: doc.workspaceId,
      experimentId: doc.experimentId,
      path: doc.path,
    })),
  );
}

function rememberExperiment(workspaceId: string, experimentId: string | null): void {
  const memory = readJson<Record<string, string>>(EXPERIMENT_MEMORY_KEY, {});
  if (experimentId) memory[workspaceId] = experimentId;
  else delete memory[workspaceId];
  writeJson(EXPERIMENT_MEMORY_KEY, memory);
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The draft state is per document, so a failed write shows on that tab only. */
function setDraftState(
  id: string,
  draftState: EditorDoc["draftState"],
  draftError: string | null,
): void {
  useWorkbench.setState((state) => ({
    docs: state.docs.map((doc) => (doc.id === id ? { ...doc, draftState, draftError } : doc)),
  }));
}

/**
 * Writes the unsaved buffer to disk and reports whether it landed. A dirty
 * document whose draft cannot be written stays `failed` until a later write
 * succeeds; nothing in the UI is allowed to treat it as safely stored.
 */
async function persistDraft(doc: EditorDoc): Promise<boolean> {
  if (doc.content === doc.savedContent) {
    const result = await removeDraft(doc.id);
    setDraftState(doc.id, result.ok ? "idle" : "failed", result.ok ? null : result.error);
    return result.ok;
  }
  const result = await saveDraft({
    docId: doc.id,
    workspaceId: doc.workspaceId,
    serverKey: doc.serverKey,
    serverLabel: doc.serverLabel,
    projectName: doc.projectName,
    path: doc.path,
    absolutePath: doc.absolutePath,
    content: doc.content,
    baseHash: doc.hash,
    updatedAt: now(),
  });
  // An edit that arrived while this write was in flight schedules its own
  // write; the state below describes the content this call saved.
  setDraftState(doc.id, result.ok ? "saved" : "failed", result.error);
  return result.ok;
}

function scheduleDraft(doc: EditorDoc, delay = 600): void {
  const pending = draftTimers.get(doc.id);
  if (pending) clearTimeout(pending);
  setDraftState(doc.id, "pending", null);
  draftTimers.set(
    doc.id,
    setTimeout(() => {
      draftTimers.delete(doc.id);
      void persistDraft(doc);
    }, delay),
  );
}

function flushDraft(doc: EditorDoc): Promise<boolean> {
  const pending = draftTimers.get(doc.id);
  if (pending) {
    clearTimeout(pending);
    draftTimers.delete(doc.id);
  }
  return persistDraft(doc);
}

function dropDocFromMemory(id: string): void {
  const timer = draftTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    draftTimers.delete(id);
  }
}

interface StartRunInput {
  workspaceId: string;
  experimentId: string;
  command: string;
  env: string;
  gpu: string;
  snapshot: SnapshotMode;
  excludes: string[];
  execution: ExecutionMode;
  links: string[];
  /** Launch even though the editor has unsaved edits. */
  allowUnsynced: boolean;
  resumedFrom?: string | null;
}

interface WorkbenchState {
  view: View;
  data: WorkspaceData;
  status: Status;
  error: string | null;
  activeWorkspaceId: string | null;
  activeExperimentId: string | null;
  activeRunId: string | null;
  docs: EditorDoc[];
  activeDocId: string | null;
  /** Unsaved buffers stored on disk, across every project. */
  drafts: Draft[];
  draftsError: string | null;
  draftsDir: string;
  draftsBytes: number;
  draftsUnreadable: number;
  draftsOpen: boolean;
  probes: Record<string, ProjectProbe>;
  probeErrors: Record<string, string>;
  files: Record<string, FileList>;
  filesErrors: Record<string, string>;
  git: Record<string, GitState>;
  gitErrors: Record<string, string>;
  runErrors: Record<string, string>;
  runCheckedAt: Record<string, number>;
  notice: string | null;

  init: () => Promise<void>;
  setView: (view: View) => void;
  setNotice: (notice: string | null) => void;
  refreshDrafts: () => Promise<void>;
  setDraftsOpen: (open: boolean) => void;
  discardDraft: (docId: string) => Promise<void>;
  activateWorkspace: (id: string) => void;
  activateExperiment: (id: string | null) => void;
  setActiveRun: (id: string | null) => void;

  saveWorkspace: (workspace: Workspace) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  saveExperiment: (experiment: Experiment) => Promise<Experiment>;
  deleteExperiment: (id: string) => Promise<void>;

  connect: (workspaceId: string) => Promise<boolean>;
  ensureProbe: (workspaceId: string) => Promise<ProjectProbe | null>;
  refreshFiles: (workspaceId: string) => Promise<void>;
  refreshGit: (workspaceId: string) => Promise<void>;
  openFile: (
    workspaceId: string,
    experimentId: string,
    path: string,
    line?: number,
  ) => Promise<void>;
  activateDoc: (id: string) => void;
  clearReveal: (id: string) => void;
  updateDoc: (id: string, content: string) => void;
  saveDoc: (id: string, force?: boolean) => Promise<boolean>;
  reloadDoc: (id: string) => Promise<void>;
  /**
   * Closes a tab. Resolves `false` when unsaved content could not be stored,
   * in which case the tab stays open: closing it would lose the edit.
   * `discard` closes anyway and gives up the buffer.
   */
  closeDoc: (id: string, discard?: boolean) => Promise<boolean>;
  /** Retries the local write of a dirty buffer; resolves whether it landed. */
  retryDraft: (id: string) => Promise<boolean>;
  checkRemoteDoc: (id: string) => Promise<void>;

  openTerminal: (workspaceId: string) => Promise<void>;
  startRun: (input: StartRunInput) => Promise<RunRecord>;
  refreshRun: (runId: string) => Promise<void>;
  stopRun: (runId: string) => Promise<void>;
  resumeCommand: (runId: string) => WorkspaceCommand | null;
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  view: readView(),
  data: { workspaces: [], experiments: [], runs: [] },
  status: "idle",
  error: null,
  activeWorkspaceId: null,
  activeExperimentId: null,
  activeRunId: null,
  docs: [],
  activeDocId: null,
  drafts: [],
  draftsError: null,
  draftsDir: "",
  draftsBytes: 0,
  draftsUnreadable: 0,
  draftsOpen: false,
  probes: {},
  probeErrors: {},
  files: {},
  filesErrors: {},
  git: {},
  gitErrors: {},
  runErrors: {},
  runCheckedAt: {},
  notice: null,

  async init() {
    if (get().status === "loading") return;
    set({ status: "loading", error: null });
    // Drafts come from disk, not from the project records: they are loaded
    // even when the record file itself cannot be read, so the recovery list
    // still works.
    await importLegacyDrafts();
    await get().refreshDrafts();
    try {
      const data = await wb.loadData();
      const remembered = localStorage.getItem(LAST_WORKSPACE_KEY);
      const workspace =
        data.workspaces.find((item) => item.id === remembered) ??
        data.workspaces.find((item) => item.id === get().activeWorkspaceId) ??
        data.workspaces[0] ??
        null;
      const experiments = workspace ? experimentsOf(data, workspace.id) : [];
      const rememberedExperiment = workspace
        ? readJson<Record<string, string>>(EXPERIMENT_MEMORY_KEY, {})[workspace.id]
        : null;
      const experiment =
        experiments.find((item) => item.id === rememberedExperiment) ??
        experiments.find((item) => item.id === workspace?.baselineExperimentId) ??
        experiments[0] ??
        null;
      set({
        data,
        status: "ready",
        activeWorkspaceId: workspace?.id ?? null,
        activeExperimentId: experiment?.id ?? null,
        activeRunId: workspace
          ? (runsOf(data, workspace.id, experiment?.id)[0]?.id ?? null)
          : null,
      });
      if (workspace) {
        if (connectedTabFor(workspace.server)) {
          void get().ensureProbe(workspace.id);
          void get().refreshFiles(workspace.id);
          void get().refreshGit(workspace.id);
          void restoreOpenFiles(get);
        }
      }
    } catch (error) {
      set({ status: "error", error: errorInfo(error).message });
    }
  },

  setView(view) {
    set({ view });
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Remembering the view is a convenience.
    }
    if (view === "workbench") void get().init();
  },

  setNotice(notice) {
    set({ notice });
  },

  async refreshDrafts() {
    const result = await reloadDrafts();
    set({
      drafts: cachedDrafts(),
      draftsError: result.ok ? draftLoadError() : result.error,
      draftsDir: draftDirectory(),
      draftsBytes: draftBytes(),
      draftsUnreadable: draftUnreadable(),
    });
  },

  setDraftsOpen(open) {
    set({ draftsOpen: open });
    if (open) void get().refreshDrafts();
  },

  async discardDraft(docId) {
    const result = await removeDraft(docId);
    if (!result.ok) {
      set({ notice: result.error ?? t("wb.draftWriteFailed") });
    }
    await get().refreshDrafts();
  },

  activateWorkspace(id) {
    const state = get();
    const workspace = state.data.workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const experiments = experimentsOf(state.data, id);
    const remembered = readJson<Record<string, string>>(EXPERIMENT_MEMORY_KEY, {})[id];
    const experiment =
      experiments.find((item) => item.id === state.activeExperimentId) ??
      experiments.find((item) => item.id === remembered) ??
      experiments.find((item) => item.id === workspace.baselineExperimentId) ??
      experiments[0] ??
      null;
    set({
      activeWorkspaceId: id,
      activeExperimentId: experiment?.id ?? null,
      activeRunId: runsOf(state.data, id, experiment?.id)[0]?.id ?? null,
    });
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, id);
    } catch {
      // See setView.
    }
    rememberExperiment(id, experiment?.id ?? null);
    // Switching projects should also put the terminal view back on the
    // terminal that belongs to this project, when one is already open.
    const app = useStore.getState();
    const terminal = app.tabs.find(
      (tab) => tab.workspaceId === id && tab.state === "connected",
    );
    if (terminal) app.setActive(terminal.info.id);
    if (connectedTabFor(workspace.server)) {
      void get().ensureProbe(id);
      void get().refreshFiles(id);
      void get().refreshGit(id);
      void restoreOpenFiles(get);
    }
  },

  activateExperiment(id) {
    const state = get();
    const workspace = state.activeWorkspaceId
      ? state.data.workspaces.find((item) => item.id === state.activeWorkspaceId)
      : null;
    if (!workspace) return;
    const experiment = id
      ? experimentsOf(state.data, workspace.id).find((item) => item.id === id) ?? null
      : null;
    set({
      activeExperimentId: experiment?.id ?? null,
      activeRunId: runsOf(state.data, workspace.id, experiment?.id)[0]?.id ?? null,
    });
    rememberExperiment(workspace.id, experiment?.id ?? null);
    void get().refreshFiles(workspace.id);
    void get().refreshGit(workspace.id);
  },

  setActiveRun(id) {
    set({ activeRunId: id });
  },

  async saveWorkspace(workspace) {
    const saved = await wb.saveWorkspace(workspace);
    const data = await wb.loadData();
    set({ data });
    get().activateWorkspace(saved.id);
    return saved;
  },

  async deleteWorkspace(id) {
    const data = await wb.deleteWorkspace(id);
    const docs = get().docs.filter((doc) => doc.workspaceId !== id);
    for (const doc of get().docs.filter((item) => item.workspaceId === id)) {
      // The project is gone: its drafts have no tab that could restore them.
      // The backend deletes them with the record; this only drops the mirror.
      dropDocFromMemory(doc.id);
      forgetEditorState(doc.id);
    }
    set({
      data,
      docs,
      activeDocId: docs.some((doc) => doc.id === get().activeDocId)
        ? get().activeDocId
        : (docs[0]?.id ?? null),
    });
    void get().refreshDrafts();
    const first = data.workspaces[0] ?? null;
    if (get().activeWorkspaceId === id || !get().activeWorkspaceId) {
      if (first) get().activateWorkspace(first.id);
      else {
        set({
          activeWorkspaceId: null,
          activeExperimentId: null,
          activeRunId: null,
        });
      }
    }
  },

  async saveExperiment(experiment) {
    const saved = await wb.saveExperiment(experiment);
    set({ data: await wb.loadData() });
    if (get().activeWorkspaceId === saved.workspaceId) {
      set({ activeExperimentId: saved.id });
      rememberExperiment(saved.workspaceId, saved.id);
      void get().refreshFiles(saved.workspaceId);
      void get().refreshGit(saved.workspaceId);
    }
    return saved;
  },

  async deleteExperiment(id) {
    const data = await wb.deleteExperiment(id);
    set({ data });
    if (get().activeExperimentId === id) {
      const workspace = data.workspaces.find(
        (item) => item.id === get().activeWorkspaceId,
      );
      const experiments = workspace ? experimentsOf(data, workspace.id) : [];
      const next = experiments[0] ?? null;
      set({ activeExperimentId: next?.id ?? null, activeRunId: null });
      if (workspace) rememberExperiment(workspace.id, next?.id ?? null);
    }
  },

  async connect(workspaceId) {
    const workspace = get().data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return false;
    try {
      await ensureSessionFor(workspace.server);
      await get().ensureProbe(workspaceId);
      await get().refreshFiles(workspaceId);
      await get().refreshGit(workspaceId);
      await restoreOpenFiles(get);
      return true;
    } catch (error) {
      set({ notice: errorInfo(error).message });
      return false;
    }
  },

  async ensureProbe(workspaceId) {
    if (get().probes[workspaceId]) return get().probes[workspaceId];
    const workspace = get().data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return null;
    try {
      const session = liveSession(workspace.server);
      const probe = await wb.probe(session, workspace.root);
      set((state) => ({
        probes: { ...state.probes, [workspaceId]: probe },
        probeErrors: { ...state.probeErrors, [workspaceId]: "" },
      }));
      return probe;
    } catch (error) {
      set((state) => ({
        probeErrors: { ...state.probeErrors, [workspaceId]: errorInfo(error).message },
      }));
      return null;
    }
  },

  async refreshFiles(workspaceId) {
    const state = get();
    const workspace = state.data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    const experiment =
      state.data.experiments.find((item) => item.id === state.activeExperimentId) ?? null;
    const root = experimentRoot(workspace, experiment);
    const key = `${workspaceId}:${root}`;
    try {
      const session = liveSession(workspace.server);
      const files = await wb.listFiles(session, root);
      set((current) => ({
        files: boundedView(current.files, key, files),
        filesErrors: { ...current.filesErrors, [key]: "" },
      }));
    } catch (error) {
      set((current) => ({
        filesErrors: { ...current.filesErrors, [key]: errorInfo(error).message },
      }));
    }
  },

  async refreshGit(workspaceId) {
    const state = get();
    const workspace = state.data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    const experiment =
      state.data.experiments.find((item) => item.id === state.activeExperimentId) ?? null;
    const root = experimentRoot(workspace, experiment);
    const key = `${workspaceId}:${root}`;
    try {
      const session = liveSession(workspace.server);
      const git = await wb.gitState(session, root);
      set((current) => ({
        git: boundedView(current.git, key, git),
        gitErrors: { ...current.gitErrors, [key]: "" },
      }));
    } catch (error) {
      set((current) => ({
        gitErrors: { ...current.gitErrors, [key]: errorInfo(error).message },
      }));
    }
  },

  async openFile(workspaceId, experimentId, path, line) {
    const state = get();
    const workspace = state.data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    const experiment = state.data.experiments.find((item) => item.id === experimentId) ?? null;
    const root = experimentRoot(workspace, experiment);
    const absolutePath = path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
    const id = draftKey(workspaceId, absolutePath);
    const existing = state.docs.find((doc) => doc.id === id);
    if (existing) {
      set({
        activeDocId: id,
        docs: state.docs.map((doc) =>
          doc.id === id
            ? { ...doc, revealLine: line ?? doc.revealLine, lastActiveAt: now() }
            : doc,
        ),
      });
      void get().checkRemoteDoc(id);
      return;
    }
    const doc: EditorDoc = {
      id,
      workspaceId,
      experimentId,
      serverKey: serverKey(workspace.server),
      serverLabel: serverLabel(workspace.server),
      projectName: workspace.name,
      path,
      absolutePath,
      content: "",
      savedContent: "",
      hash: "",
      remoteHash: null,
      size: 0,
      encoding: "UTF-8",
      eol: "lf",
      bom: false,
      modifiedAt: null,
      sync: "loading",
      error: null,
      draftRestored: false,
      draftState: "idle",
      draftError: null,
      revealLine: line ?? null,
      lastActiveAt: now(),
    };
    evictDocs(get, set, doc);
    set({ docs: [...get().docs, doc], activeDocId: id });
    try {
      const session = liveSession(workspace.server);
      const remote = await wb.readText(session, absolutePath);
      // The mirror is authoritative for "is there a draft"; make sure it has
      // been read before deciding that this file has none.
      await ensureDraftsLoaded();
      const draft = cachedDraft(id);
      const sameServer = draft?.serverKey === doc.serverKey;
      if (draft && sameServer && draft.content !== remote.content) {
        const restored: EditorDoc = {
          ...doc,
          content: draft.content,
          savedContent: remote.content,
          hash: remote.hash,
          remoteHash: draft.baseHash === remote.hash ? null : remote.hash,
          size: remote.size,
          encoding: remote.encoding,
          eol: remote.eol,
          bom: remote.bom,
          modifiedAt: remote.modifiedAt,
          sync: draft.baseHash === remote.hash ? "dirty" : "conflict",
          draftRestored: true,
          draftState: "saved",
          draftError: null,
          error:
            draft.baseHash === remote.hash ? null : t("wb.draftConflict"),
        };
        replaceDoc(set, get, restored);
        rememberOpenFiles(get().docs);
        return;
      }
      // A draft written against another server is never applied here. It is
      // kept on disk and listed in the recovery view, with the identity it
      // came from, instead of being silently dropped.
      const foreign = draft !== null && !sameServer && draft.content !== remote.content;
      const loaded: EditorDoc = {
        ...doc,
        content: remote.content,
        savedContent: remote.content,
        hash: remote.hash,
        size: remote.size,
        encoding: remote.encoding,
        eol: remote.eol,
        bom: remote.bom,
        modifiedAt: remote.modifiedAt,
        sync: "synced",
        error: foreign
          ? t("wb.draftForeign", { server: draft?.serverKey ?? "" })
          : null,
        draftState: "idle",
        draftError: null,
      };
      replaceDoc(set, get, loaded);
      // A draft can only be retired automatically when it belongs to this
      // server, or when it is byte-identical to what the server now has. A
      // draft from another host is kept for recovery, not written over.
      if (draft && (sameServer || draft.content === remote.content)) {
        void removeDraft(id);
      }
      rememberOpenFiles(get().docs);
    } catch (error) {
      replaceDoc(set, get, {
        ...doc,
        sync: "failed",
        error: errorInfo(error).message,
      });
    }
  },

  activateDoc(id) {
    set((state) => ({
      activeDocId: id,
      docs: state.docs.map((doc) =>
        doc.id === id ? { ...doc, lastActiveAt: now() } : doc,
      ),
    }));
    void get().checkRemoteDoc(id);
  },

  clearReveal(id) {
    set((state) => ({
      docs: state.docs.map((doc) =>
        doc.id === id ? { ...doc, revealLine: null } : doc,
      ),
    }));
  },

  updateDoc(id, content) {
    const state = get();
    const doc = state.docs.find((item) => item.id === id);
    if (!doc) return;
    const sync =
      content === doc.savedContent
        ? "synced"
        : doc.sync === "conflict"
          ? "conflict"
          : "dirty";
    const next: EditorDoc = { ...doc, content, sync };
    replaceDoc(set, get, next);
    if (sync === "dirty") scheduleDraft(next);
    else if (sync === "synced") {
      const timer = draftTimers.get(id);
      if (timer) clearTimeout(timer);
      draftTimers.delete(id);
      // Reverting to the server copy makes the draft obsolete. A failure to
      // delete it is reported by the recovery list, not hidden here.
      void removeDraft(id);
      setDraftState(id, "idle", null);
    }
  },

  async saveDoc(id, force = false) {
    const state = get();
    const doc = state.docs.find((item) => item.id === id);
    if (!doc || doc.sync === "saving" || doc.sync === "loading") return false;
    const content = doc.content;
    replaceDoc(set, get, { ...doc, sync: "saving", error: null });
    try {
      const workspace = get().data.workspaces.find((item) => item.id === doc.workspaceId);
      if (!workspace) throw new Error(t("wb.profileMissing"));
      const session = liveSession(workspace.server);
      const result = await wb.writeText(session, {
        path: doc.absolutePath,
        content,
        expectedHash: doc.hash || null,
        eol: doc.eol,
        bom: doc.bom,
        force,
        encoding: doc.encoding,
      });
      const current = get().docs.find((item) => item.id === id);
      const stillTheSame = (current?.content ?? content) === content;
      // A replace that went through but could not be verified is not a save:
      // the buffer stays dirty and its draft stays on disk until a reload
      // shows what the server really has.
      if (result.uncertain) {
        const next: EditorDoc = {
          ...(current ?? doc),
          content: current?.content ?? content,
          hash: result.hash,
          size: result.size,
          remoteHash: result.hash,
          sync: "dirty",
          error: result.note || t("wb.writeUncertain"),
        };
        replaceDoc(set, get, next);
        await persistDraft(next);
        return false;
      }
      const next: EditorDoc = {
        ...(current ?? doc),
        content: current?.content ?? content,
        savedContent: content,
        hash: result.hash,
        size: result.size,
        remoteHash: null,
        sync: stillTheSame ? "synced" : "dirty",
        error: null,
      };
      replaceDoc(set, get, next);
      if (next.sync === "synced") {
        void removeDraft(id);
        setDraftState(id, "idle", null);
      } else scheduleDraft(next);
      void get().refreshGit(doc.workspaceId);
      return true;
    } catch (error) {
      const info = errorInfo(error);
      const conflicting = info.code === "conflict";
      const current = get().docs.find((item) => item.id === id) ?? doc;
      replaceDoc(set, get, {
        ...current,
        sync: conflicting ? "conflict" : "failed",
        error: info.message,
      });
      await flushDraft(current);
      return false;
    }
  },

  async reloadDoc(id) {
    const doc = get().docs.find((item) => item.id === id);
    if (!doc) return;
    replaceDoc(set, get, { ...doc, sync: "loading", error: null });
    try {
      const workspace = get().data.workspaces.find((item) => item.id === doc.workspaceId);
      if (!workspace) throw new Error(t("wb.profileMissing"));
      const session = liveSession(workspace.server);
      const remote = await wb.readText(session, doc.absolutePath);
      replaceDoc(set, get, {
        ...doc,
        content: remote.content,
        savedContent: remote.content,
        hash: remote.hash,
        remoteHash: null,
        size: remote.size,
        encoding: remote.encoding,
        eol: remote.eol,
        bom: remote.bom,
        modifiedAt: remote.modifiedAt,
        sync: "synced",
        error: null,
        draftRestored: false,
        draftState: "idle",
        draftError: null,
      });
      void removeDraft(id);
      void get().refreshGit(doc.workspaceId);
    } catch (error) {
      replaceDoc(set, get, {
        ...doc,
        sync: "failed",
        error: errorInfo(error).message,
      });
    }
  },

  async retryDraft(id) {
    const doc = get().docs.find((item) => item.id === id);
    if (!doc) return false;
    const stored = await flushDraft(doc);
    if (stored) void get().refreshDrafts();
    return stored;
  },

  async closeDoc(id, discard = false) {
    const doc = get().docs.find((item) => item.id === id);
    if (!doc) return true;
    if (doc.content !== doc.savedContent && !discard) {
      // Closing a dirty tab is only safe once the buffer is on disk. When it
      // is not, the tab stays open and says why: silently dropping the tab
      // would drop the edit with it.
      const stored = await flushDraft(doc);
      if (!stored) {
        const current = get().docs.find((item) => item.id === id);
        setDraftState(
          id,
          "failed",
          current?.draftError ?? t("wb.draftWriteFailed"),
        );
        set({ notice: t("wb.draftCloseBlocked") });
        return false;
      }
    } else if (doc.content === doc.savedContent) {
      void removeDraft(id);
    }
    const docs = get().docs.filter((item) => item.id !== id);
    // Closing releases the document state with the tab: a later open starts a
    // new undo history instead of one that can reach behind this file.
    forgetEditorState(id);
    set({
      docs,
      activeDocId:
        get().activeDocId === id
          ? (docs[docs.length - 1]?.id ?? null)
          : get().activeDocId,
    });
    rememberOpenFiles(docs);
    void get().refreshDrafts();
    return true;
  },

  async checkRemoteDoc(id) {
    const doc = get().docs.find((item) => item.id === id);
    if (!doc || doc.sync === "loading" || doc.sync === "saving") return;
    const workspace = get().data.workspaces.find((item) => item.id === doc.workspaceId);
    if (!workspace) return;
    const session = connectedTabFor(workspace.server)?.info.id;
    if (!session) return;
    try {
      const stat = await wb.statFile(session, doc.absolutePath);
      const changed =
        !stat.exists ||
        stat.size !== doc.size ||
        (stat.modifiedAt ?? 0) !== (doc.modifiedAt ?? 0);
      if (changed && !doc.remoteHash) {
        set((state) => ({
          docs: state.docs.map((item) =>
            item.id === id ? { ...item, remoteHash: "changed" } : item,
          ),
        }));
      }
    } catch {
      // A probe is best-effort; the hash check on save stays authoritative.
    }
  },

  async openTerminal(workspaceId) {
    const workspace = get().data.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    const experiment =
      get().data.experiments.find((item) => item.id === get().activeExperimentId) ?? null;
    const root = experimentRoot(workspace, experiment);
    await openWorkspaceTerminal(
      workspaceId,
      workspace.name,
      workspace.server,
      root,
      workspace.env,
    );
  },

  async startRun(input) {
    const state = get();
    const workspace = state.data.workspaces.find((item) => item.id === input.workspaceId);
    const experiment = state.data.experiments.find((item) => item.id === input.experimentId);
    if (!workspace || !experiment) throw new Error(t("wb.runNoExperiment"));
    const root = experimentRoot(workspace, experiment);
    // What the editor still holds back is exactly what a run would not see.
    const unsynced = state.docs
      .filter(
        (doc) =>
          doc.workspaceId === workspace.id &&
          doc.content !== doc.savedContent &&
          (doc.absolutePath === root || doc.absolutePath.startsWith(`${root.replace(/\/+$/, "")}/`)),
      )
      .map((doc) => doc.absolutePath);
    const session = await ensureSessionFor(workspace.server);
    const run = draftRun({
      id: crypto.randomUUID(),
      workspace,
      experiment,
      root,
      command: input.command,
      env: input.env,
      gpu: input.gpu,
      resumedFrom: input.resumedFrom ?? null,
    });
    const launch = await wb.startRun(session, {
      run,
      runRoot: workspace.runRoot,
      snapshot: input.snapshot,
      excludes: input.excludes,
      execution: input.execution,
      links: input.links,
      unsynced,
      requireClean: !input.allowUnsynced,
    });
    set((current) => ({
      data: {
        ...current.data,
        runs: [launch.run, ...current.data.runs.filter((item) => item.id !== launch.run.id)],
      },
      activeRunId: launch.run.id,
      runCheckedAt: { ...current.runCheckedAt, [launch.run.id]: now() },
      notice: launch.warnings.length ? launch.warnings.join(" ") : current.notice,
    }));
    return launch.run;
  },

  async refreshRun(runId) {
    const state = get();
    const run = state.data.runs.find((item) => item.id === runId);
    if (!run) return;
    const session = connectedTabFor(run.server)?.info.id;
    if (!session) {
      set((current) => ({
        runErrors: {
          ...current.runErrors,
          [runId]: t("wb.runSessionGone"),
        },
        runCheckedAt: { ...current.runCheckedAt, [runId]: now() },
      }));
      return;
    }
    try {
      const observation = await wb.runStatus(session, run);
      const changed =
        observation.status !== run.status || observation.exitCode !== run.exitCode;
      set((current) => ({
        data: {
          ...current.data,
          runs: current.data.runs.map((item) =>
            item.id === runId
              ? {
                  ...item,
                  status: observation.status,
                  exitCode: observation.exitCode,
                  endedAt:
                    observation.exitCode === null ? item.endedAt : now(),
                  lastSeenAt: observation.checkedAt,
                }
              : item,
          ),
        },
        runErrors: { ...current.runErrors, [runId]: "" },
        runCheckedAt: { ...current.runCheckedAt, [runId]: observation.checkedAt },
      }));
      // Persist an observation when it says something new, or every 30s so a
      // long-running launch still has a fresh last-seen time after a restart.
      if (changed || observation.checkedAt - run.lastSeenAt > 30_000) {
        void wb
          .updateRun({
            id: run.id,
            status: observation.status,
            exitCode: observation.exitCode,
            endedAt: observation.exitCode === null ? run.endedAt : observation.checkedAt,
            lastSeenAt: observation.checkedAt,
            note: observation.note,
          })
          .catch(() => undefined);
      }
    } catch (error) {
      set((current) => ({
        runErrors: { ...current.runErrors, [runId]: errorInfo(error).message },
        runCheckedAt: { ...current.runCheckedAt, [runId]: now() },
      }));
    }
  },

  async stopRun(runId) {
    const state = get();
    const run = state.data.runs.find((item) => item.id === runId);
    if (!run) return;
    const session = await ensureSessionFor(run.server);
    await wb.stopRun(session, run);
    const updated = await wb.updateRun({
      id: run.id,
      status: "stopped",
      exitCode: run.exitCode,
      endedAt: now(),
      lastSeenAt: now(),
      note: t("wb.stoppedByUser"),
    });
    set((current) => ({
      data: {
        ...current.data,
        runs: current.data.runs.map((item) => (item.id === runId ? updated : item)),
      },
    }));
    void get().refreshRun(runId);
  },

  resumeCommand(runId) {
    const run = get().data.runs.find((item) => item.id === runId);
    if (!run) return null;
    return {
      id: run.id,
      label: run.command.split("\n")[0]?.slice(0, 80) ?? "",
      command: run.command,
      kind: "other",
    };
  },
}));

function replaceDoc(
  set: (partial: Partial<WorkbenchState>) => void,
  get: () => WorkbenchState,
  doc: EditorDoc,
): void {
  set({
    docs: get().docs.map((item) => (item.id === doc.id ? doc : item)),
  });
}

function liveSession(server: Workspace["server"]): string {
  const tab = connectedTabFor(server);
  if (!tab) throw new Error(t("wb.noSession"));
  return tab.info.id;
}

/**
 * Releases a saved document before adding another. A document with unsaved
 * content is never evicted: its draft is written first only when the user
 * closes it, and losing the tab would hide that the draft exists.
 */
function evictDocs(
  get: () => WorkbenchState,
  set: (partial: Partial<WorkbenchState>) => void,
  incoming: EditorDoc,
): void {
  let docs = get().docs;
  if (docs.some((doc) => doc.id === incoming.id)) return;
  const chars = docs.reduce((total, doc) => total + doc.content.length, 0);
  while (
    docs.length >= MAX_DOCS ||
    (chars + incoming.content.length > MAX_DOC_CHARS && docs.length > 1)
  ) {
    const candidate = [...docs]
      .filter((doc) => doc.sync === "synced")
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!candidate) break;
    docs = docs.filter((doc) => doc.id !== candidate.id);
    dropDocFromMemory(candidate.id);
    forgetEditorState(candidate.id);
    rememberOpenFiles(docs);
  }
  if (docs.length >= HARD_MAX_DOCS) {
    throw new Error(t("wb.editorLimit", { count: HARD_MAX_DOCS }));
  }
  if (docs !== get().docs) set({ docs });
}

async function restoreOpenFiles(get: () => WorkbenchState): Promise<void> {
  const state = get();
  if (!state.activeWorkspaceId) return;
  const remembered = openFiles().filter(
    (entry) => entry.workspaceId === state.activeWorkspaceId,
  );
  if (remembered.length === 0 || state.docs.some((doc) => doc.workspaceId === state.activeWorkspaceId)) {
    return;
  }
  for (const entry of remembered.slice(0, MAX_DOCS)) {
    if (!state.data.experiments.some((item) => item.id === entry.experimentId)) continue;
    try {
      await get().openFile(entry.workspaceId, entry.experimentId, entry.path);
    } catch {
      // A file removed since the last session only costs its tab.
    }
  }
}

export function defaultRunCommand(workspaceId: string): WorkspaceCommand | null {
  const workspace = useWorkbench
    .getState()
    .data.workspaces.find((item) => item.id === workspaceId);
  return workspace ? defaultCommand(workspace) : null;
}

export function docSyncLabel(doc: EditorDoc): string {
  if (doc.sync === "loading") return t("wb.loading");
  if (doc.sync === "saving") return t("wb.saving");
  if (doc.sync === "conflict") return t("wb.remoteChanged");
  if (doc.sync === "failed") return t("wb.saveFailedShort");
  if (doc.content !== doc.savedContent) return t("wb.unsaved");
  if (doc.remoteHash) return t("wb.remoteChanged");
  return t("wb.synced");
}
