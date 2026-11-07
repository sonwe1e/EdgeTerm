/**
 * History materialization (roadmap A2-6/7, decision D14): turning exported
 * history records back into escape sequences and prepending them into a live
 * xterm buffer, the last building block of seamless history scrolling.
 *
 * Records are logical lines with cell-coordinate SGR runs. Rendering them
 * goes through a throwaway scratch terminal: the records become escapes
 * (recordsToEscapes), the scratch re-parses them — re-wrapping at the
 * TARGET's current column count, which is the intended display behavior —
 * and the scratch's buffer lines are then MOVED (not cloned; the scratch is
 * disposed afterwards) into the top of the target buffer through the same
 * CircularList splice xterm's own InputHandler uses (see
 * terminalHistoryPrepend.ts). Callers keep the viewport stable with
 * shiftViewport and clear selections before prepending.
 */
import { Terminal } from "@xterm/xterm";
import { DEFAULT_COLOR, type HistoryRecord, type HistoryRun } from "./terminalHistory";
import { internalList } from "./terminalHistoryPrepend";

// xterm's color packing (common/buffer/Constants.ts; semanticPaint cites the
// same layout): color mode in bits 25-26, RGB/palette below.
const CM_MASK = 0x3000000;
const CM_RGB = 0x3000000;

const FLAG_ON: Array<[number, number]> = [
  [1, 1],
  [2, 2],
  [4, 3],
  [8, 4],
  [16, 5],
  [32, 7],
  [64, 8],
  [128, 9],
];
const FLAG_OFF: Array<[number, number]> = [
  [1, 22],
  [2, 22],
  [4, 23],
  [8, 24],
  [16, 25],
  [32, 27],
  [64, 28],
  [128, 29],
];

/**
 * The SGR sequence that turns the previous style into this run's style, or
 * "" when nothing changes. prev === null means the previous style is the
 * terminal default. Palette colors (any non-RGB mode) re-emit as 38;5;n /
 * 48;5;n, so a re-parsed P16 color compares as its 256-color index.
 */
export function sgrForRun(run: HistoryRun, prev: HistoryRun | null): string {
  const parts: string[] = [];
  const prevFg = prev?.fg ?? DEFAULT_COLOR;
  const prevBg = prev?.bg ?? DEFAULT_COLOR;
  const prevFlags = prev?.flags ?? 0;
  if (run.fg !== prevFg) parts.push(...colorCodes(run.fg, 38, 39));
  if (run.bg !== prevBg) parts.push(...colorCodes(run.bg, 48, 49));
  for (const [bit, code] of FLAG_ON) {
    if (run.flags & bit && !(prevFlags & bit)) parts.push(`${code}`);
  }
  for (const [bit, code] of FLAG_OFF) {
    if (prevFlags & bit && !(run.flags & bit) && !parts.includes(`${code}`)) parts.push(`${code}`);
  }
  if (parts.length === 0) return "";
  return `\u001b[${parts.join(";")}m`;
}

function colorCodes(word: number, colorBase: number, defaultCode: number): string[] {
  if (word === DEFAULT_COLOR) return [`${defaultCode}`];
  if ((word & CM_MASK) === CM_RGB) {
    return [`${colorBase};2;${(word >>> 16) & 0xff};${(word >>> 8) & 0xff};${word & 0xff}`];
  }
  return [`${colorBase};5;${word & 0xff}`];
}

/**
 * Simplified wcwidth for cell↔string-index mapping: 0 for combining marks
 * and zero-width joiners, 2 for the common East-Asian wide and emoji blocks,
 * 1 otherwise. Records come from terminal cells, whose characters only ever
 * carried widths 0/1/2 there, so this table covers capture-produced text.
 */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** The rendered cell width of a record text. */
export function cellWidth(text: string): number {
  let width = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    width += charWidth(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return width;
}

/** The substring covering cells [from, to); a straddling wide character is
 * kept whole. */
function sliceByCells(text: string, from: number, to: number): string {
  let out = "";
  let cell = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    const width = charWidth(codePoint);
    const size = codePoint > 0xffff ? 2 : 1;
    if (cell + width > from && cell < to) out += text.slice(index, index + size);
    cell += width;
    index += size;
    if (cell >= to) break;
  }
  return out;
}

/**
 * Records as terminal input: each record's styled text followed by CRLF
 * (the last record has none). Style state never leaks across records, and
 * default gaps between runs reset the attributes.
 */
export function recordsToEscapes(records: readonly HistoryRecord[]): string {
  const defaultStyle = (): HistoryRun => ({
    start: 0,
    len: 0,
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    flags: 0,
  });
  let out = "";
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    let state: HistoryRun = defaultStyle();
    let cell = 0;
    for (const run of record.runs) {
      if (run.start > cell) {
        out += sgrForRun(defaultStyle(), state);
        state = defaultStyle();
        out += sliceByCells(record.text, cell, run.start);
        cell = run.start;
      }
      out += sgrForRun(run, state);
      state = { ...run };
      out += sliceByCells(record.text, cell, run.start + run.len);
      cell = run.start + run.len;
    }
    const width = cellWidth(record.text);
    if (cell < width) out += sliceByCells(record.text, cell, width);
    if (state.fg !== DEFAULT_COLOR || state.bg !== DEFAULT_COLOR || state.flags !== 0) {
      out += "\u001b[0m";
    }
    if (index < records.length - 1) out += "\r\n";
  }
  return out;
}

/**
 * Materializes records into a scratch terminal and moves its buffer lines to
 * the top of the target's normal buffer. The scratch re-wraps at the
 * target's current columns, so the number of prepended rows can exceed the
 * record count; that count is what the promise resolves to. Resolves 0 —
 * without touching the target — when there is nothing to prepend or the
 * buffer internals do not match the expected shapes. The viewport is not
 * shifted here; callers use shiftViewport (terminalHistoryPrepend.ts).
 */
export async function prependRecords(
  term: Terminal,
  records: readonly HistoryRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const target = internalList(term);
  if (!target) return 0;
  const cols = Math.max(1, term.cols);
  // One row per cell of width, rounded up per record (the scratch re-wraps
  // at the target's columns; summing widths globally would undercount).
  let scratchRows = 0;
  for (const record of records) {
    scratchRows += Math.max(1, Math.ceil(cellWidth(record.text) / cols));
  }
  const scratch = new Terminal({ cols, rows: 2, scrollback: scratchRows + 8 });
  try {
    await new Promise<void>((resolve) => scratch.write(recordsToEscapes(records), resolve));
    const list = internalList(scratch);
    if (!list) return 0;
    const lines: unknown[] = [];
    for (let index = 0; index < list.length; index++) {
      const line = list.get(index);
      if (!line) return 0;
      lines.push(line);
    }
    const lengthBefore = target.length;
    // Grow the capacity first: CircularList.splice trims from the oldest
    // end when an insertion would exceed maxLength (see prependClonedLines).
    target.maxLength += lines.length;
    target.splice(0, 0, ...lines);
    if (target.length !== lengthBefore + lines.length) return 0;
    return lines.length;
  } finally {
    scratch.dispose();
  }
}
