import type { FileEntry } from "./types";

/**
 * Type-to-select for the file lists (upstream issue #108): typing the first
 * letters of a name selects the entry whose name starts with them, the way
 * Finder, Explorer and VS Code lists do. This module is the pure half — the
 * panels keep the run in a ref between key presses and own the DOM work
 * (moving the keyboard cursor, scrolling the row into view).
 */

/** A pause this long ends a type-to-select run; the next key starts afresh. */
export const TYPE_SELECT_RESET_MS = 1000;

/** What has been typed into a file list so far; see `typeToSelect`. */
export interface TypeRun {
  text: string;
  /** When its last key arrived, in `performance.now()` time. */
  at: number;
}

/** The parts of a key press `typeToSelect` reads. */
export type TypedKey = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
>;

/** What a typed key means for a list; see `typeToSelect`. */
export interface TypeSelectResult {
  /** The run this key extends, to hand back on the next key. */
  run: TypeRun;
  /**
   * The entry the run selects, or -1 when nothing matches and the selection
   * should stay where it was.
   */
  index: number;
}

/**
 * Type-to-select, the way Finder, Explorer and VS Code lists do it: typing
 * the start of a name selects the first entry whose name starts with what
 * was typed, ignoring case, and keys that follow within
 * `TYPE_SELECT_RESET_MS` extend it. `anchor` is the list's active entry —
 * the row the keyboard cursor is on, or the last one clicked — so a new run
 * searches from the entry after it, and pressing the same letter again after
 * a pause steps to the next name with it. A run keeps its entry while that
 * still matches. Typing one letter over and over steps through the names
 * starting with it unless some name starts with the repeated letters ("ss"
 * finds `ssh`).
 *
 * Null for a key that is not typing, which the list leaves alone: modified
 * keys are shortcuts, named keys (Enter, the arrows) are not text, and a
 * space only continues a run, since otherwise it scrolls the list.
 */
export function typeToSelect(
  entries: readonly FileEntry[],
  anchor: string | null,
  run: TypeRun | null,
  key: TypedKey,
  now: number,
): TypeSelectResult | null {
  if (key.ctrlKey || key.metaKey || key.altKey || key.isComposing) return null;
  if (key.key.length !== 1) return null;
  const live = run !== null && now - run.at < TYPE_SELECT_RESET_MS ? run : null;
  if (key.key === " " && !live) return null;

  const text = (live?.text ?? "") + key.key;
  const current = anchor === null ? -1 : entries.findIndex((entry) => entry.path === anchor);
  // A continued run keeps looking from its own entry (so a second letter may
  // still match the same name); a fresh run starts after the active one, which
  // is what makes the same letter pressed again step through the names.
  let index = findByPrefix(entries, text, live ? current : current + 1);
  if (index < 0 && text.length > 1 && [...text].every((character) => character === text[0])) {
    index = findByPrefix(entries, text[0], current + 1);
  }
  return { run: { text, at: now }, index };
}

/** The first entry from `start` on, wrapping around, whose name starts with `prefix`. */
export function findByPrefix(entries: readonly FileEntry[], prefix: string, start: number): number {
  const wanted = foldName(prefix);
  const from = Math.max(start, 0);
  for (let offset = 0; offset < entries.length; offset++) {
    const index = (from + offset) % entries.length;
    if (foldName(entries[index].name).startsWith(wanted)) return index;
  }
  return -1;
}

/**
 * A name as type-to-select compares it. Keyboards type composed characters,
 * while a name may hold decomposed ones (HFS+ stored every name that way).
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
