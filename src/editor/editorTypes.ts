/**
 * The built-in editor's own document shape. Only the fields the editor and
 * its single-file caller read are here; the richer record the experiment
 * workbench used to carry is gone with it.
 */

/** The editor's per-file state. */
export type DocSync = "loading" | "synced" | "dirty" | "saving" | "conflict" | "failed";

/** Whether the local draft of a dirty document is safely on disk. */
export type DraftState = "idle" | "pending" | "saved" | "failed";

export interface EditorDoc {
  /** Stable per document; the single-file editor keys its view on it. */
  id: string;
  /** The path shown as the document's title. */
  path: string;
  content: string;
  /** Set when an editor was asked to reveal a search hit. */
  revealLine: number | null;
}

export interface TextFile {
  path: string;
  content: string;
  hash: string;
  size: number;
  encoding: string;
  eol: string;
  bom: boolean;
  modifiedAt: number | null;
  permissions: number | null;
}
