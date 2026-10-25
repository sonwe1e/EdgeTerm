import type { DiffRow } from "./api";

export const DIFF_ROW_HEIGHT = 28;
export const DIFF_LINE_HEIGHT = 20;

export interface DiffChange {
  start: number;
  end: number;
}

/** Adjacent changed rows form one navigation stop, even when their kinds differ. */
export function diffChanges(rows: readonly DiffRow[]): DiffChange[] {
  const changes: DiffChange[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].kind === "equal") continue;
    const previous = changes[changes.length - 1];
    if (previous?.end === index) previous.end++;
    else changes.push({ start: index, end: index + 1 });
  }
  return changes;
}

/** The row containing a content offset; offsets includes the final bottom edge. */
export function diffRowAt(offsets: readonly number[], top: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= top) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** Only an initial estimate: mounted rows are measured with the browser's layout. */
export function estimateDiffHeight(row: DiffRow, width: number, wrap: boolean): number {
  if (!wrap) return DIFF_ROW_HEIGHT;
  const columns = Math.max(1, Math.floor((width / 2 - 124) / 7.3));
  const length = (text: string | null) =>
    (text ?? "").replace(/\t/g, "    ").replace(/[^\x00-\x7f]/g, "xx").length;
  const lines = Math.max(1, Math.ceil(Math.max(length(row.left), length(row.right)) / columns));
  return lines * DIFF_LINE_HEIGHT + 8;
}
