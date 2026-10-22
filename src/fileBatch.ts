import type { PaneSide } from "./paneDrop";
import type { FileEntry } from "./types";

/**
 * The entries picked in a dual-pane file list (upstream issue #101): their
 * paths, and the one a Shift-click range is measured from. A new listing
 * starts empty. The Filer panel keeps its own selection over the same paths
 * (`useFileSelection`); this is the model the FTP / SFTP panes share.
 */
export interface FileSelection {
  paths: string[];
  anchor: string | null;
}

export const EMPTY_SELECTION: FileSelection = { paths: [], anchor: null };

/** What a click does to the selection; see `clickMode`. */
export type SelectMode = "replace" | "toggle" | "range";

/**
 * How a press on an entry changes the selection, the way the system file
 * managers do it: ⌘-click (Ctrl-click elsewhere) adds or drops one entry,
 * Shift-click selects everything from the anchor, a plain click selects just
 * that entry. Null leaves the selection to the context menu: any button but
 * the primary one, and Control-click on macOS, which is a right click there
 * and must not collapse the selection it is about to act on.
 */
export function clickMode(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey">,
  mac: boolean,
): SelectMode | null {
  if (event.button !== 0) return null;
  if (mac && event.ctrlKey) return null;
  if (event.shiftKey) return "range";
  if (mac ? event.metaKey : event.ctrlKey) return "toggle";
  return "replace";
}

/**
 * The selection after a click on `path`. `order` is the list as shown, which
 * is what a range spans; a range whose anchor is no longer listed starts over
 * from the clicked entry.
 */
export function selectEntry(
  selection: FileSelection,
  order: readonly string[],
  path: string,
  mode: SelectMode,
): FileSelection {
  if (mode === "toggle") {
    const paths = selection.paths.includes(path)
      ? selection.paths.filter((selected) => selected !== path)
      : [...selection.paths, path];
    return { paths, anchor: path };
  }
  if (mode === "range" && selection.anchor !== null) {
    const from = order.indexOf(selection.anchor);
    const to = order.indexOf(path);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      return { paths: order.slice(start, end + 1), anchor: selection.anchor };
    }
  }
  return { paths: [path], anchor: path };
}

/**
 * The selection a right click on `path` acts on: the whole selection when the
 * entry is part of it, otherwise that entry alone.
 */
export function selectForMenu(selection: FileSelection, path: string): FileSelection {
  return selection.paths.includes(path) ? selection : { paths: [path], anchor: path };
}

/** The selected entries in the order the list shows them. */
export function selectedEntries(
  entries: readonly FileEntry[],
  selection: FileSelection,
): FileEntry[] {
  const picked = new Set(selection.paths);
  return entries.filter((entry) => picked.has(entry.path));
}

/**
 * Why a batch cannot land where it was headed. Carries the entry that is in
 * the way, not a sentence: the message is the pane's, in the user's language
 * (see the `ftp.*` messages).
 */
export interface BatchBlock {
  /** Local links are never written through; the backend refuses them too. */
  kind: "symlink" | "kindMismatch";
  /** The entry already sitting in the destination that stops the batch. */
  existing: FileEntry;
}

/** What copying several entries into one folder runs into; see `batchCollisions`. */
export interface BatchCollisions {
  /** Why the batch cannot start at all, or null. */
  blocked: BatchBlock | null;
  /**
   * Incoming items whose name is already taken by the same kind: files are
   * replaced, folders are merged into. Confirm these once for the whole batch.
   */
  existing: FileEntry[];
}

/**
 * Checks a batch of `items` against the folder they are about to land in,
 * which already holds `present`, before anything is sent: stopping halfway
 * would leave the user to work out which half arrived. `destination` is the
 * side being written. A download also refuses a local link, which the backend
 * will not write through. `foldCase` matches names the way a case-insensitive
 * file system does (macOS, Windows).
 *
 * Names that would leave the destination are left to the backend, which
 * refuses them before a path is built (see the transfer engine's local path
 * validation) — refusing them here would need a message the catalog has no
 * key for.
 */
export function batchCollisions(
  items: readonly FileEntry[],
  present: readonly FileEntry[],
  destination: PaneSide,
  foldCase = false,
): BatchCollisions {
  const key = (name: string) => (foldCase ? name.toLowerCase() : name);
  const byName = new Map(present.map((entry) => [key(entry.name), entry]));
  const existing: FileEntry[] = [];
  for (const item of items) {
    const taken = byName.get(key(item.name));
    if (!taken) continue;
    if (destination === "local" && taken.isSymlink) {
      return { blocked: { kind: "symlink", existing: taken }, existing: [] };
    }
    if (taken.isDir !== item.isDir) {
      return { blocked: { kind: "kindMismatch", existing: taken }, existing: [] };
    }
    existing.push(item);
  }
  return { blocked: null, existing };
}

/** The footer name for item `index` of `count`: just the name when it is alone. */
export function batchItemName(name: string, index: number, count: number): string {
  return count > 1 ? `${name} (${index + 1}/${count})` : name;
}
