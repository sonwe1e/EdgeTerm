import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../store";
import * as wb from "./api";
import { connectedTabFor, ensureSessionFor } from "./session";
import { useWorkbench } from "./store";
import type { Draft } from "./draftTypes";
import type { RunRecord, Workspace, WorkspaceData } from "./types";

const draftStore = vi.hoisted(() => ({
  stored: new Map<string, Draft>(),
  failSave: false,
}));

vi.mock("./drafts", async () => {
  const actual = await vi.importActual<typeof import("./drafts")>("./drafts");
  return {
    ...actual,
    ensureDraftsLoaded: async () => undefined,
    cachedDraft: (id: string) => draftStore.stored.get(id) ?? null,
    cachedDrafts: () => [...draftStore.stored.values()],
    saveDraft: async (draft: Draft) => {
      if (draftStore.failSave) return { ok: false, error: "No space left on device" };
      draftStore.stored.set(draft.docId, draft);
      return { ok: true, error: null };
    },
    removeDraft: async (id: string) => {
      draftStore.stored.delete(id);
      return { ok: true, error: null };
    },
    reloadDrafts: async () => ({ ok: true, error: null }),
    draftBytes: () => 0,
    draftDirectory: () => "",
    draftUnreadable: () => 0,
    draftLoadError: () => null,
    importLegacyDrafts: async () => 0,
  };
});

vi.mock("./api", () => ({
  loadData: vi.fn(),
  saveWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  saveExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  recordRun: vi.fn(),
  updateRun: vi.fn(),
  deleteRun: vi.fn(),
  probe: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  statFile: vi.fn(),
  listFiles: vi.fn(),
  search: vi.fn(),
  gitState: vi.fn(),
  gitDiff: vi.fn(),
  readLog: vi.fn(),
  startRun: vi.fn(),
  runStatus: vi.fn(),
  stopRun: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("./session", () => ({
  connectedTabFor: vi.fn(),
  ensureSessionFor: vi.fn(),
  openWorkspaceTerminal: vi.fn(),
  shellQuote: (value: string) => `'${value}'`,
}));

const server = (host: string, profileId: string) => ({
  profileId,
  name: host,
  host,
  port: 22,
  username: "lab",
});

const workspace = (
  id: string,
  name: string,
  host: string,
  profileId: string,
  root: string,
): Workspace => ({
  id,
  name,
  server: server(host, profileId),
  root,
  env: "conda activate vfi",
  commands: [],
  runRoot: "",
  baselineExperimentId: null,
  createdAt: 1,
  updatedAt: 1,
});

const DATA: WorkspaceData = {
  workspaces: [
    workspace("w1", "baseline", "gpu-01", "p1", "/data/vfi/base"),
    workspace("w2", "ablation A", "gpu-01", "p1", "/data/vfi/abl_a"),
    workspace("w3", "ablation B", "gpu-02", "p2", "/mnt/fast/abl_b"),
  ],
  experiments: [
    {
      id: "e1",
      workspaceId: "w1",
      name: "baseline",
      kind: "baseline",
      baselineId: null,
      root: null,
      branch: "main",
      notes: "",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "e2",
      workspaceId: "w2",
      name: "loss variant",
      kind: "variant",
      baselineId: "e1",
      root: "/data/vfi/abl_a",
      branch: null,
      notes: "",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "e3",
      workspaceId: "w3",
      name: "baseline",
      kind: "baseline",
      baselineId: null,
      root: null,
      branch: null,
      notes: "",
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  runs: [],
};

const tab = (id: string, profileId: string, address: string): Tab =>
  ({
    info: {
      id,
      profileId,
      name: address,
      kind: "ssh",
      protocol: "ssh",
      address,
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: profileId, name: address, kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "root",
  }) as unknown as Tab;

const remote = (path: string, content: string, hash: string) => ({
  path,
  content,
  hash,
  size: content.length,
  encoding: "UTF-8",
  eol: "lf",
  bom: false,
  modifiedAt: 10,
  permissions: 0o644,
});

/** A write result with the fields the editor reads. */
const writeOk = (path: string, hash: string, size: number) => ({
  path,
  hash,
  size,
  backup: null,
  temp: null,
  uncertain: false,
  note: "",
});

function seedDraft(input: {
  docId: string;
  workspaceId: string;
  path: string;
  absolutePath: string;
  content: string;
  baseHash: string;
  serverKey?: string;
}): void {
  draftStore.stored.set(input.docId, {
    docId: input.docId,
    workspaceId: input.workspaceId,
    serverKey: input.serverKey ?? "lab@gpu-01:22",
    serverLabel: "gpu-01",
    projectName: "baseline",
    path: input.path,
    absolutePath: input.absolutePath,
    content: input.content,
    baseHash: input.baseHash,
    updatedAt: 1,
  });
}

function resetStore(): void {
  useWorkbench.setState({
    data: { workspaces: [], experiments: [], runs: [] },
    status: "ready",
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
  });
}

describe("workbench store: three projects", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    draftStore.stored.clear();
    draftStore.failSave = false;
    resetStore();
    vi.mocked(wb.loadData).mockResolvedValue(structuredClone(DATA));
    vi.mocked(wb.listFiles).mockImplementation(async (_session, root) => ({
      root,
      files: [`${root}/src/train.py`.replace(root, "").replace(/^\//, "")],
      truncated: false,
      source: "git",
    }));
    vi.mocked(wb.gitState).mockResolvedValue({
      isRepository: true,
      branch: "main",
      commit: "abc",
      dirty: false,
      files: [],
      diffSha256: "",
      diffBytes: 0,
      diffTruncated: false,
      note: "",
    });
    vi.mocked(wb.probe).mockResolvedValue({
      os: "Linux",
      home: "/home/lab",
      shell: "/bin/bash",
      git: true,
      tmux: true,
      python: "/usr/bin/python3",
      conda: true,
      nvidiaSmi: true,
      scheduler: "slurm",
      isRepository: true,
      rootExists: true,
      paths: [],
    });
    vi.mocked(wb.statFile).mockImplementation(async (_session, path) => ({
      path,
      exists: true,
      size: 10,
      modifiedAt: 10,
    }));
    vi.mocked(ensureSessionFor).mockImplementation(async (target) =>
      target.profileId === "p1" ? "s1" : "s2",
    );
    vi.mocked(connectedTabFor).mockImplementation((target) => {
      if (target.profileId === "p1") return tab("s1", "p1", "gpu-01:22");
      if (target.profileId === "p2") return undefined;
      return undefined;
    });
    vi.mocked(wb.readText).mockImplementation(async (_session, path) =>
      remote(path, `content of ${path}`, `hash:${path}`),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the same relative path in two projects on one server without crossing them", async () => {
    await useWorkbench.getState().init();
    expect(useWorkbench.getState().activeWorkspaceId).toBe("w1");

    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    await useWorkbench.getState().activateWorkspace("w2");
    await useWorkbench.getState().openFile("w2", "e2", "src/train.py");

    const docs = useWorkbench.getState().docs;
    expect(docs).toHaveLength(2);
    const first = docs.find((doc) => doc.workspaceId === "w1");
    const second = docs.find((doc) => doc.workspaceId === "w2");
    expect(first?.absolutePath).toBe("/data/vfi/base/src/train.py");
    expect(second?.absolutePath).toBe("/data/vfi/abl_a/src/train.py");
    expect(first?.id).not.toBe(second?.id);
    expect(second?.projectName).toBe("ablation A");
    expect(second?.serverLabel).toContain("lab@gpu-01:22");
    expect(vi.mocked(wb.readText)).toHaveBeenNthCalledWith(1, "s1", "/data/vfi/base/src/train.py");
    expect(vi.mocked(wb.readText)).toHaveBeenNthCalledWith(2, "s1", "/data/vfi/abl_a/src/train.py");
  });

  it("refuses to read a project whose server is not connected", async () => {
    await useWorkbench.getState().init();
    useWorkbench.getState().activateWorkspace("w3");
    await useWorkbench.getState().openFile("w3", "e3", "src/train.py");
    const doc = useWorkbench.getState().docs[0];
    expect(doc.sync).toBe("failed");
    expect(doc.error).toContain("Connect");
    expect(vi.mocked(wb.readText)).not.toHaveBeenCalled();
  });

  it("keeps each project's file listing under its own root", async () => {
    await useWorkbench.getState().init();
    await useWorkbench.getState().refreshFiles("w1");
    useWorkbench.getState().activateWorkspace("w2");
    await useWorkbench.getState().refreshFiles("w2");
    const files = useWorkbench.getState().files;
    expect(files["w1:/data/vfi/base"].root).toBe("/data/vfi/base");
    expect(files["w2:/data/vfi/abl_a"].root).toBe("/data/vfi/abl_a");
  });
});

describe("workbench store: drafts and saves", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    draftStore.stored.clear();
    draftStore.failSave = false;
    resetStore();
    vi.mocked(wb.loadData).mockResolvedValue(structuredClone(DATA));
    vi.mocked(wb.listFiles).mockResolvedValue({
      root: "",
      files: [],
      truncated: false,
      source: "git",
    });
    vi.mocked(wb.gitState).mockResolvedValue({
      isRepository: false,
      branch: "",
      commit: "",
      dirty: false,
      files: [],
      diffSha256: "",
      diffBytes: 0,
      diffTruncated: false,
      note: "",
    });
    vi.mocked(ensureSessionFor).mockResolvedValue("s1");
    vi.mocked(connectedTabFor).mockReturnValue(tab("s1", "p1", "gpu-01:22"));
  });

  it("restores a draft whose base still matches the server", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    const docId = `w1::${docPath}`;
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "server\n", "h1"));
    seedDraft({
      docId,
      workspaceId: "w1",
      path: "src/train.py",
      absolutePath: docPath,
      content: "local draft\n",
      baseHash: "h1",
    });
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const doc = useWorkbench.getState().docs[0];
    expect(doc.content).toBe("local draft\n");
    expect(doc.savedContent).toBe("server\n");
    expect(doc.sync).toBe("dirty");
    expect(doc.draftRestored).toBe(true);
  });

  it("marks a draft as a conflict when the server copy moved on", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    const docId = `w1::${docPath}`;
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "newer server\n", "h2"));
    seedDraft({
      docId,
      workspaceId: "w1",
      path: "src/train.py",
      absolutePath: docPath,
      content: "local draft\n",
      baseHash: "h1",
    });
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const doc = useWorkbench.getState().docs[0];
    expect(doc.sync).toBe("conflict");
    expect(doc.remoteHash).toBe("h2");
    expect(doc.content).toBe("local draft\n");
  });

  it("flags a draft from another server identity without applying or deleting it", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    const docId = `w1::${docPath}`;
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "server\n", "h1"));
    seedDraft({
      docId,
      workspaceId: "w1",
      path: "src/train.py",
      absolutePath: docPath,
      content: "draft from the old host\n",
      baseHash: "h1",
      serverKey: "lab@gpu-old:22",
    });
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const doc = useWorkbench.getState().docs[0];
    // The server copy is shown; the old host's text is not written over it.
    expect(doc.content).toBe("server\n");
    expect(doc.sync).toBe("synced");
    expect(doc.draftRestored).toBe(false);
    // The notice names the source and the recovery list keeps the content.
    expect(doc.error).toContain("gpu-old");
    expect(useWorkbench.getState().drafts.some((item) => item.docId === docId)).toBe(true);
    expect(draftStore.stored.has(docId)).toBe(true);
  });

  it("sends the base hash on save and clears the draft on success", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    vi.mocked(wb.writeText).mockResolvedValue(writeOk(docPath, "h2", 8));
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "new\n");
    const saved = await useWorkbench.getState().saveDoc(id);
    expect(saved).toBe(true);
    expect(vi.mocked(wb.writeText)).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        path: docPath,
        expectedHash: "h1",
        content: "new\n",
        force: false,
      }),
    );
    const doc = useWorkbench.getState().docs[0];
    expect(doc.sync).toBe("synced");
    expect(doc.hash).toBe("h2");
  });

  it("keeps the draft when the server refuses the save as a conflict", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    vi.mocked(wb.writeText).mockRejectedValue({
      code: "conflict",
      message: "the file changed on the server",
    });
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "mine\n");
    const saved = await useWorkbench.getState().saveDoc(id);
    expect(saved).toBe(false);
    const doc = useWorkbench.getState().docs[0];
    expect(doc.sync).toBe("conflict");
    expect(doc.content).toBe("mine\n");
  });

  it("does not silently reconnect to save", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "mine\n");
    vi.mocked(connectedTabFor).mockReturnValue(undefined);
    const saved = await useWorkbench.getState().saveDoc(id);
    expect(saved).toBe(false);
    expect(vi.mocked(wb.writeText)).not.toHaveBeenCalled();
    expect(useWorkbench.getState().docs[0].sync).toBe("failed");
    expect(useWorkbench.getState().docs[0].content).toBe("mine\n");
  });

  it("keeps an unsaved tab open when its draft cannot be written", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "mine\n");

    draftStore.failSave = true;
    const closed = await useWorkbench.getState().closeDoc(id);
    expect(closed).toBe(false);
    expect(useWorkbench.getState().docs.some((doc) => doc.id === id)).toBe(true);
    expect(useWorkbench.getState().docs[0].draftState).toBe("failed");
    expect(useWorkbench.getState().notice).toBeTruthy();

    draftStore.failSave = false;
    expect(await useWorkbench.getState().retryDraft(id)).toBe(true);
    expect(draftStore.stored.get(id)?.content).toBe("mine\n");
    expect(await useWorkbench.getState().closeDoc(id)).toBe(true);
    expect(useWorkbench.getState().docs).toHaveLength(0);
  });

  it("closes without storing only when the edit is explicitly discarded", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "mine\n");
    draftStore.failSave = true;
    expect(await useWorkbench.getState().closeDoc(id, true)).toBe(true);
    expect(useWorkbench.getState().docs).toHaveLength(0);
    expect(draftStore.stored.has(id)).toBe(false);
  });

  it("releases the least recently used saved document, never a dirty one", async () => {
    await useWorkbench.getState().init();
    for (let index = 0; index < 9; index += 1) {
      await useWorkbench.getState().openFile("w1", "e1", `src/f${index}.py`);
    }
    const docs = useWorkbench.getState().docs;
    expect(docs).toHaveLength(8);
    expect(docs.some((doc) => doc.path === "src/f0.py")).toBe(false);

    const dirty = docs[0];
    useWorkbench.getState().updateDoc(dirty.id, "unsaved\n");
    for (let index = 20; index < 27; index += 1) {
      await useWorkbench.getState().openFile("w1", "e1", `src/f${index}.py`);
    }
    const after = useWorkbench.getState().docs;
    expect(after.some((doc) => doc.id === dirty.id)).toBe(true);
    expect(after.length).toBeLessThanOrEqual(16);
  });
});

describe("workbench store: runs", () => {
  const running: RunRecord = {
    id: "r1",
    workspaceId: "w1",
    experimentId: "e1",
    server: server("gpu-01", "p1"),
    root: "/data/vfi/base",
    command: "python train.py",
    env: "",
    gpu: "0",
    scheduler: null,
    submitOnly: false,
    mode: "tmux",
    status: "running",
    startedAt: 100,
    endedAt: null,
    exitCode: null,
    code: {
      branch: "main",
      commit: "abc",
      dirty: false,
      dirtyFiles: [],
      diffSha256: "",
      diffBytes: 0,
      diffTruncated: false,
      isRepository: true,
    },
    snapshot: { mode: "code", path: "", files: 0, bytes: 0, skipped: 0, verified: false, note: "" },
    binding: {
      execution: "workspace",
      executedFrom: "/data/vfi/base",
      workspaceRoot: "/data/vfi/base",
      isolated: false,
      snapshotVerified: false,
      unsynced: [],
      links: [],
      note: "",
    },
    runDir: "/data/vfi/base/.edgeterm/runs/r1",
    logPath: "/data/vfi/base/.edgeterm/runs/r1/run.log",
    taskName: "et-r1",
    resumedFrom: null,
    note: "",
    lastSeenAt: 100,
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    draftStore.stored.clear();
    draftStore.failSave = false;
    resetStore();
    const data = structuredClone(DATA);
    data.runs = [running];
    vi.mocked(wb.loadData).mockResolvedValue(data);
    vi.mocked(wb.listFiles).mockResolvedValue({
      root: "",
      files: [],
      truncated: false,
      source: "git",
    });
    vi.mocked(wb.gitState).mockResolvedValue({
      isRepository: true,
      branch: "main",
      commit: "abc",
      dirty: false,
      files: [],
      diffSha256: "",
      diffBytes: 0,
      diffTruncated: false,
      note: "",
    });
    vi.mocked(connectedTabFor).mockReturnValue(tab("s1", "p1", "gpu-01:22"));
    vi.mocked(ensureSessionFor).mockResolvedValue("s1");
  });

  it("loads an existing run without starting anything", async () => {
    await useWorkbench.getState().init();
    expect(useWorkbench.getState().data.runs[0].status).toBe("running");
    expect(vi.mocked(wb.startRun)).not.toHaveBeenCalled();
  });

  it("records a run against the project's experiment and server, not a tab id", async () => {
    vi.mocked(wb.startRun).mockResolvedValue({
      run: {
        ...running,
        id: "r2",
        experimentId: "e2",
        root: "/data/vfi/abl_a",
        runDir: "/data/vfi/abl_a/.edgeterm/runs/r2",
        logPath: "/data/vfi/abl_a/.edgeterm/runs/r2/run.log",
        taskName: "et-r2",
        status: "running",
      },
      warnings: [],
      uncertain: false,
    });
    await useWorkbench.getState().init();
    const created = await useWorkbench.getState().startRun({
      workspaceId: "w2",
      experimentId: "e2",
      command: "python train.py",
      env: "",
      gpu: "0",
      snapshot: "code",
      excludes: [],
      execution: "workspace",
      links: [],
      allowUnsynced: false,
    });
    expect(created.experimentId).toBe("e2");
    expect(created.server.profileId).toBe("p1");
    expect(vi.mocked(wb.startRun)).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        run: expect.objectContaining({
          workspaceId: "w2",
          experimentId: "e2",
          root: "/data/vfi/abl_a",
        }),
        snapshot: "code",
      }),
    );
    expect(useWorkbench.getState().data.runs[0].id).toBe("r2");
  });

  it("requires a clean launch and names the edits a run would not include", async () => {
    const docPath = "/data/vfi/base/src/train.py";
    vi.mocked(wb.readText).mockResolvedValue(remote(docPath, "old\n", "h1"));
    vi.mocked(wb.startRun).mockResolvedValue({
      run: {
        ...running,
        id: "r3",
        status: "unknown",
        binding: {
          execution: "isolated",
          executedFrom: "/data/vfi/base/.edgeterm/runs/r3/code",
          workspaceRoot: "/data/vfi/base",
          isolated: true,
          snapshotVerified: true,
          unsynced: [docPath],
          links: ["datasets"],
          note: "",
        },
      },
      warnings: ["the launch result could not be read"],
      uncertain: true,
    });
    await useWorkbench.getState().init();
    await useWorkbench.getState().openFile("w1", "e1", "src/train.py");
    const id = useWorkbench.getState().docs[0].id;
    useWorkbench.getState().updateDoc(id, "mine\n");

    const created = await useWorkbench.getState().startRun({
      workspaceId: "w1",
      experimentId: "e1",
      command: "python train.py",
      env: "",
      gpu: "",
      snapshot: "code",
      excludes: [],
      execution: "isolated",
      links: ["datasets"],
      allowUnsynced: false,
    });

    expect(vi.mocked(wb.startRun)).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        unsynced: [docPath],
        requireClean: true,
        execution: "isolated",
        links: ["datasets"],
      }),
    );
    expect(created.binding.snapshotVerified).toBe(true);
    expect(created.binding.executedFrom).toContain("/code");
    expect(useWorkbench.getState().notice).toContain("could not be read");
  });

  it("marks a status stale instead of inventing one when the session is gone", async () => {
    await useWorkbench.getState().init();
    vi.mocked(connectedTabFor).mockReturnValue(undefined);
    await useWorkbench.getState().refreshRun("r1");
    expect(vi.mocked(wb.runStatus)).not.toHaveBeenCalled();
    expect(useWorkbench.getState().runErrors.r1).toContain("session is closed");
    expect(useWorkbench.getState().data.runs[0].status).toBe("running");
    expect(vi.mocked(wb.startRun)).not.toHaveBeenCalled();
  });

  it("persists a changed observation and leaves the launch identity alone", async () => {
    vi.mocked(wb.runStatus).mockResolvedValue({
      status: "finished",
      exitCode: 0,
      alive: false,
      logSize: 100,
      checkedAt: 200,
      note: "",
    });
    vi.mocked(wb.updateRun).mockResolvedValue({ ...running, status: "finished", exitCode: 0 });
    await useWorkbench.getState().init();
    await useWorkbench.getState().refreshRun("r1");
    const run = useWorkbench.getState().data.runs[0];
    expect(run.status).toBe("finished");
    expect(run.exitCode).toBe(0);
    expect(run.command).toBe("python train.py");
    expect(vi.mocked(wb.updateRun)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", status: "finished", exitCode: 0 }),
    );
    expect(vi.mocked(wb.startRun)).not.toHaveBeenCalled();
  });
});
