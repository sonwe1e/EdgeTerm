import { create } from "zustand";
import { errorInfo, errorText } from "./errorInfo";
import { t } from "./i18n";
import { ask } from "./nativeDialog";
import { useStore } from "./store";
import * as api from "./editor/textFile";
import type { TextFile } from "./editor/editorTypes";

export interface FileEditorTarget {
  id: string;
  sessionId: string | null;
  path: string;
  label: string;
  /** 1-based line to reveal when the file opens; cleared once revealed. */
  line: number | null;
}
interface State {
  target: FileEditorTarget | null;
  file: TextFile | null;
  content: string;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  saved: boolean;
}
const empty: State = {
  target: null,
  file: null,
  content: "",
  busy: false,
  error: null,
  conflict: false,
  saved: false,
};
export const useFileEditor = create<State>(() => ({ ...empty }));
export const hasUnsavedFile = () => {
  const state = useFileEditor.getState();
  return state.busy || Boolean(state.file && state.content !== normalizeText(state.file.content));
};
const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n");
// A native discard/reload confirmation can yield before it owns window focus.
// Other destructive actions must not run behind that outstanding decision.
let confirming = false;
let openRevision = 0;

/** Reserve the user's open intent before resolving a terminal link's directory. */
export function beginFileEditorOpen(): number | null {
  if (confirming || useFileEditor.getState().busy) return null;
  return ++openRevision;
}

export const isFileEditorOpenCurrent = (request: number): boolean => request === openRevision;

async function closeCurrentEditor(): Promise<boolean> {
  const before = useFileEditor.getState();
  if (confirming || before.busy) return false;
  confirming = true;
  try {
    if (hasUnsavedFile() && !(await ask(t("fileEditor.discard"), { kind: "warning" })))
      return false;
    const current = useFileEditor.getState();
    if (
      current.target?.id !== before.target?.id ||
      current.busy ||
      current.content !== before.content ||
      current.file !== before.file
    )
      return false;
    useFileEditor.setState({ ...empty });
    return true;
  } finally {
    confirming = false;
  }
}

export async function closeFileEditor(): Promise<boolean> {
  if (confirming || useFileEditor.getState().busy) return false;
  // A pending read must not reopen a dialog after an explicit close/quit.
  openRevision += 1;
  return closeCurrentEditor();
}

/** Keeps a printed line number inside the editor's own range. */
const revealLineOf = (line: number | undefined): number | null =>
  line !== undefined && Number.isFinite(line) && line >= 1 ? Math.floor(line) : null;

/**
 * Opens one file in the built-in editor.
 *
 * The file is read before the dialog is shown, so a missing, unreadable,
 * oversized or binary file reports in the status bar instead of opening an
 * empty editor shell; the read doubles as the existence check for a path a
 * terminal link printed. False means the read failed and another candidate
 * directory may be tried. Null means cancelled/superseded: callers must stop.
 */
export async function openFileEditor(
  sessionId: string | null,
  path: string,
  options: { line?: number; request?: number } = {},
): Promise<boolean | null> {
  const request = options.request ?? beginFileEditorOpen();
  if (request === null || !isFileEditorOpenCurrent(request) || confirming) return null;
  if (useFileEditor.getState().target && !(await closeCurrentEditor())) return null;
  if (!isFileEditorOpenCurrent(request)) return null;
  const tab = useStore.getState().tabs.find((item) => item.info.id === sessionId);
  const target: FileEditorTarget = {
    id: crypto.randomUUID(),
    sessionId,
    path,
    label: tab
      ? `${tab.info.name} · ${tab.info.address}`
      : t(sessionId ? "fileEditor.remote" : "fileEditor.local"),
    line: revealLineOf(options.line),
  };
  if (tab?.info.kind === "ftp") {
    useFileEditor.setState({ ...empty, target, error: t("fileEditor.ftpUnsupported") });
    return false;
  }
  let file: TextFile;
  try {
    file = await api.readText(sessionId, path);
  } catch (error) {
    if (!isFileEditorOpenCurrent(request)) return null;
    useStore.getState().setStatus(t("status.linkOpenFailed", { path, error: errorText(error) }));
    return false;
  }
  // Request order, not read completion order, decides which file the user sees.
  if (!isFileEditorOpenCurrent(request)) return null;
  useFileEditor.setState({ ...empty, target, file, content: normalizeText(file.content) });
  return true;
}

/** Drops the pending reveal line once the editor has scrolled to it. */
export function clearRevealLine(): void {
  const { target } = useFileEditor.getState();
  if (!target || target.line === null) return;
  useFileEditor.setState({ target: { ...target, line: null } });
}

export async function reloadFileEditor() {
  const { target, busy, content: startingContent, file: startingFile } = useFileEditor.getState();
  if (!target || busy || confirming) return;
  if (hasUnsavedFile()) {
    confirming = true;
    try {
      if (!(await ask(t("fileEditor.reloadConfirm"), { kind: "warning" }))) return;
    } finally {
      confirming = false;
    }
  }
  const ownsTarget = () => useFileEditor.getState().target?.id === target.id;
  // The native confirmation can yield to another action.
  const current = useFileEditor.getState();
  if (
    !ownsTarget() ||
    current.busy ||
    current.content !== startingContent ||
    current.file !== startingFile
  )
    return;
  useFileEditor.setState({ busy: true, error: null });
  try {
    const file = await api.readText(target.sessionId, target.path);
    if (!ownsTarget()) return;
    if (useFileEditor.getState().content !== startingContent) {
      useFileEditor.setState({ error: t("fileEditor.reloadInterrupted") });
      return;
    }
    useFileEditor.setState({
      file,
      content: normalizeText(file.content),
      conflict: false,
      saved: false,
    });
  } catch (error) {
    if (ownsTarget()) useFileEditor.setState({ error: errorText(error) });
  } finally {
    if (ownsTarget()) useFileEditor.setState({ busy: false });
  }
}

export async function saveFileEditor() {
  const { target, file, content, busy } = useFileEditor.getState();
  if (!target || !file || busy || confirming) return;
  const ownsTarget = () => useFileEditor.getState().target?.id === target.id;
  useFileEditor.setState({ busy: true, error: null });
  try {
    const result = await api.writeText(target.sessionId, {
      path: file.path,
      content,
      expectedHash: file.hash,
      encoding: file.encoding,
      eol: file.eol,
      bom: file.bom,
    });
    if (!ownsTarget()) return;
    if (result.uncertain) throw new Error(result.note || t("fileEditor.uncertain"));
    // Keep any edits typed while the save was in flight dirty against this snapshot.
    useFileEditor.setState({
      file: { ...file, path: result.path, content, hash: result.hash, size: result.size },
      conflict: false,
      saved: true,
    });
  } catch (error) {
    if (ownsTarget())
      useFileEditor.setState({
        error: errorText(error),
        conflict: errorInfo(error).code === "conflict",
        saved: false,
      });
  } finally {
    if (ownsTarget()) useFileEditor.setState({ busy: false });
  }
}
