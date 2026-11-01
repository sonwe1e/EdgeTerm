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
let closing = false;
export async function closeFileEditor(): Promise<boolean> {
  if (closing || useFileEditor.getState().busy) return false;
  closing = true;
  try {
    if (hasUnsavedFile() && !(await ask(t("fileEditor.discard"), { kind: "warning" })))
      return false;
    useFileEditor.setState({ ...empty });
    return true;
  } finally {
    closing = false;
  }
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
 * terminal link printed. Returns whether the editor opened, which lets the
 * caller try the next candidate directory for a relative path.
 */
export async function openFileEditor(
  sessionId: string | null,
  path: string,
  options: { line?: number } = {},
): Promise<boolean> {
  if (useFileEditor.getState().target && !(await closeFileEditor())) return false;
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
    useStore.getState().setStatus(t("status.linkOpenFailed", { path, error: errorText(error) }));
    return false;
  }
  // A different open may have finished while this read was in flight; that
  // target is the newer one and must not be replaced by this stale result.
  if (useFileEditor.getState().target) return false;
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
  const { target, busy } = useFileEditor.getState();
  if (!target || busy) return;
  if (hasUnsavedFile() && !(await ask(t("fileEditor.reloadConfirm"), { kind: "warning" }))) return;
  // The native confirmation can yield to another action.
  if (useFileEditor.getState().target !== target || useFileEditor.getState().busy) return;
  const startingContent = useFileEditor.getState().content;
  useFileEditor.setState({ busy: true, error: null });
  try {
    const file = await api.readText(target.sessionId, target.path);
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
    useFileEditor.setState({ error: errorText(error) });
  } finally {
    useFileEditor.setState({ busy: false });
  }
}

export async function saveFileEditor() {
  const { target, file, content, busy } = useFileEditor.getState();
  if (!target || !file || busy) return;
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
    if (result.uncertain) throw new Error(result.note || t("fileEditor.uncertain"));
    // Keep any edits typed while the save was in flight dirty against this snapshot.
    useFileEditor.setState({
      file: { ...file, path: result.path, content, hash: result.hash, size: result.size },
      conflict: false,
      saved: true,
    });
  } catch (error) {
    useFileEditor.setState({
      error: errorText(error),
      conflict: errorInfo(error).code === "conflict",
      saved: false,
    });
  } finally {
    useFileEditor.setState({ busy: false });
  }
}
