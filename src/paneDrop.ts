import type { FileEntry } from "./types";

export type PaneSide = "local" | "remote";

/** The entry a drag is carrying, recorded on dragstart and read on drop. */
export interface DraggedEntry {
  side: PaneSide;
  entry: FileEntry;
}

/**
 * Where a drop landed: a pane's current directory, or one of its folder rows
 * the entry was dropped on.
 */
export interface DropTarget {
  side: PaneSide;
  dir: string;
}

export type DropAction =
  /** A local entry heading to the remote pane. */
  | { kind: "upload" }
  /** A remote entry heading to the local pane. */
  | { kind: "download" };

/**
 * What dropping `source` on `target` does; null means the drop should be
 * refused. Dragging only copies across panes; same-side drops never move
 * entries (upstream PR #92).
 */
export function dropAction(source: DraggedEntry, target: DropTarget): DropAction | null {
  if (source.side !== target.side) {
    return source.side === "local" ? { kind: "upload" } : { kind: "download" };
  }
  return null;
}
