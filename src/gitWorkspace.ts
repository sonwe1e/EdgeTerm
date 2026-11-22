import { create } from "zustand";
import type { GitStatus, GitTarget } from "./bindings";
import { t } from "./i18n";
import { open } from "./nativeDialog";

export interface GitSource extends GitTarget {
  label: string | null;
}

export const useGitSource = create<{ source: GitSource | null }>(() => ({ source: null }));

let openRevision = 0;
export const beginGitOpen = () => ++openRevision;
export const isGitOpenCurrent = (request: number) => request === openRevision;

export function openGitWorkspace(source: GitSource, request = beginGitOpen()): void {
  if (isGitOpenCurrent(request)) useGitSource.setState({ source });
}

export function closeGitWorkspace(): void {
  beginGitOpen();
  useGitSource.setState({ source: null });
}

export async function pickGitFolder(request = beginGitOpen(), defaultPath?: string): Promise<void> {
  const directory = await open({
    title: t("git.openFolder"),
    directory: true,
    multiple: false,
    defaultPath,
  });
  if (directory) openGitWorkspace({ directory, sessionId: null, label: null }, request);
}

// A draft belongs to its host, repository and branch. Keep it for reopening
// the workbench during this app run, including round trips to the terminal.
const drafts = new Map<string, string>();
export const gitDraftKey = (source: GitSource, status: GitStatus) =>
  JSON.stringify([source.sessionId, status.root, status.branch ?? status.head]);
export const readGitDraft = (key: string) => drafts.get(key) ?? "";
export function writeGitDraft(key: string, value: string): void {
  drafts.delete(key);
  if (value) drafts.set(key, value);
  if (drafts.size > 24) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) drafts.delete(oldest);
  }
}
