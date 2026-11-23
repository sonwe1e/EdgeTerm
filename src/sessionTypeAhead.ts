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
