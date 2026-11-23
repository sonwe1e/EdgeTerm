/**
 * Type-ahead for the session tree: typing a letter while the tree has focus
 * walks to the next session whose name starts with what has been typed. It is
 * the behaviour every file manager and mail client has, and it costs nothing
 * until the reader types.
 */
export interface TypeAheadRow {
  /** Position in the tree's flattened row list. */
  index: number;
  label: string;
}

/**
 * The row to move to, or null when nothing matches.
 *
 * The search starts **after** the current row and wraps, so pressing the same
 * letter repeatedly walks through the names that share it. A growing buffer
 * ("b", then "bu") narrows the same search, which is why the caller resets the
 * buffer after a pause rather than on every keystroke.
 */
export function nextTypeAheadRow(
  rows: readonly TypeAheadRow[],
  fromIndex: number,
  query: string,
): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const ordered = [...rows].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) return null;
  const start = ordered.findIndex((row) => row.index > fromIndex);
  const origin = start === -1 ? 0 : start;
  for (let step = 0; step < ordered.length; step++) {
    const row = ordered[(origin + step) % ordered.length];
    if (row.label.toLowerCase().startsWith(needle)) return row.index;
  }
  return null;
}

/** How long a half-typed search lives: a longer pause starts a new one. */
export const TYPE_AHEAD_PAUSE_MS = 600;

/** The search so far, and when its last key arrived. */
export interface TypeAheadBuffer {
  text: string;
  at: number;
}

export interface TypeAheadKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * What one key press does to the buffer.
 *
 * - a plain printable character extends the search (a pause starts a new one);
 * - Backspace shortens it, which is how a typo is corrected without starting
 *   over — an empty buffer leaves the key alone, so it keeps whatever meaning
 *   the list gave it;
 * - Escape forgets the search **only when there is one**, so the same key can
 *   still close a menu or leave a filter;
 * - space and anything with Ctrl, ⌘ or Alt is none of type-ahead's business.
 */
export function nextTypeAheadBuffer(
  buffer: TypeAheadBuffer,
  key: TypeAheadKey,
  now: number,
  pauseMs: number = TYPE_AHEAD_PAUSE_MS,
): { buffer: TypeAheadBuffer; action: "search" | "clear" | "none" } {
  const fresh = now - buffer.at <= pauseMs;
  const text = fresh ? buffer.text : "";
  if (key.key === "Escape") {
    return text === ""
      ? { buffer, action: "none" }
      : { buffer: { text: "", at: now }, action: "clear" };
  }
  if (key.key === "Backspace") {
    if (text === "") return { buffer, action: "none" };
    return { buffer: { text: text.slice(0, -1), at: now }, action: "search" };
  }
  if (key.ctrlKey || key.metaKey || key.altKey) return { buffer, action: "none" };
  if (key.key.length !== 1 || key.key === " ") return { buffer, action: "none" };
  return { buffer: { text: text + key.key, at: now }, action: "search" };
}
