import type { FileEntry } from "../../types";
import { type MenuItem } from "../ContextMenu";

export interface TransferState {
  /**
   * `sync` is a remote file edited locally being sent back after a save;
   * `stage` is the copy a drag out of the window needs on Windows / Linux
   * before the system can take it (macOS downloads on the drop instead,
   * shown as a `download`); `copy` is a drop landing in a local folder.
   */
  kind: "upload" | "download" | "sync" | "stage" | "copy";
  name: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  status: "running" | "complete" | "error" | "cancelled";
  /** Whether the footer offers to cancel it; see `beginTransfer`. */
  cancellable: boolean;
}

export interface TransferRateSample {
  time: number;
  transferred: number;
}

/** The transfer that can be cancelled right now; see `beginTransfer`. */
export interface ActiveTransfer {
  id: string;
  /** Set once a cancel was sent, so the rejection reads as a cancel. */
  cancelled: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** An entry on its way out of the window; `staging` while its copy downloads. */
export interface DragOutState {
  path: string;
  name: string;
  /**
   * True while the copy a Windows / Linux drag needs is still downloading,
   * before the system has the drag; a release then cancels it.
   */
  staging: boolean;
}

/** A press on an entry that has not yet travelled far enough to be a drag. */
export interface DragPress {
  pointerId: number;
  x: number;
  y: number;
  entry: FileEntry;
}

/**
 * Whether a drop on the panel would be uploaded. `reason` carries the message
 * to show when it would not; null means say nothing (this panel's own drag
 * out is passing over the window).
 */
export interface DropVerdict {
  accept: boolean;
  reason: string | null;
}

export type FilerEntryKind = "directory" | "file" | "symlink";

/** An entry being named inline at the top of the list before it exists. */
export type NewEntryDraft = { kind: "file" | "folder"; name: string };
