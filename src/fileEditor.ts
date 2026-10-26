import { create } from "zustand";
import { errorInfo, errorText } from "./errorInfo";
import { t } from "./i18n";
import { ask } from "./nativeDialog";
import { useStore } from "./store";
import * as api from "./workbench/api";
import type { TextFile } from "./workbench/types";

export interface FileEditorTarget {
  id: string;
  sessionId: string | null;
  path: string;
  label: string;
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

export async function openFileEditor(sessionId: string | null, path: string) {
  if (useFileEditor.getState().target && !(await closeFileEditor())) return;
  const tab = useStore.getState().tabs.find((item) => item.info.id === sessionId);
  const target = {
    id: crypto.randomUUID(),
    sessionId,
    path,
    label: tab
      ? `${tab.info.name} · ${tab.info.address}`
      : t(sessionId ? "fileEditor.remote" : "fileEditor.local"),
  };
  useFileEditor.setState({ ...empty, target });
  if (tab?.info.kind === "ftp") {
    useFileEditor.setState({ error: t("fileEditor.ftpUnsupported") });
    return;
  }
  await reloadFileEditor();
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
