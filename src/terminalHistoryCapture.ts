/**
 * Pre-trim history export (roadmap A2-4, decision D14): the spike that
 * falsifies or validates the frontend's riskiest assumption — xterm has no
 * "about to trim" event, so lines must be exported while they are still in
 * the buffer, and the actual trimming must be verified afterwards.
 *
 * Strategy: keep a marker parked on the export frontier (the head row of the
 * oldest unexported logical line). While the marker lives, xterm itself keeps
 * its row index current through trims, so the frontier never needs manual
 * arithmetic; the moment a trim eats the frontier marker itself, unexported
 * lines were lost — that is exactly the mismatch this spike must surface
 * (export early, never late: lines are exported with a trailing margin of
 * rows still unwritten, and an exported line is never exported again).
 *
 * Resizes re-wrap the buffer and can delete or move marker rows, so a resize
 * schedules a resync that relocates the frontier by walking logical lines
 * from the bottom until one is recognized as already exported (public API
 * only). That assumes the freshest output does not repeat an already
 * exported line verbatim at the boundary — a repeat would open a gap, never
 * a duplicate. Production would match against the storage index instead of
 * the in-memory export set kept here.
 *
 * Boundaries: the integration layer calls notifyWriteParsed from xterm's
 * onWriteParsed — trims that happen inside one huge term.write before that
 * hook fires can overrun the margin, which the marker disposal then reports
 * as a mismatch rather than silently losing lines. Buffer internals are read
 * the way src/semanticPaint.ts reads them; if that layout ever changes,
 * export stops with a mismatch instead of corrupting history.
 */
import type { IBufferLine, IMarker, Terminal } from "@xterm/xterm";
import {
  DEFAULT_COLOR,
  type CellSource,
  type HistoryRecord,
  encodeHistoryBatch,
  logicalLineFromCells,
} from "./terminalHistory";

export interface HistoryCaptureOptions {
  /** Fraction of scrollback kept unwritten at the bottom before exporting. */
  scrollbackMarginRatio?: number;
  /** Epoch time of a line, or null for time 0; must be non-decreasing. */
  lineTimeAt?: (absLine: number) => number | null;
  onBatch: (bytes: Uint8Array) => void;
  onMismatch?: (detail: string) => void;
}

export interface HistoryCapture {
  /** Call from xterm's onWriteParsed hook. */
  notifyWriteParsed(): void;
  /** Call when the terminal is cleared: starts a new numbering epoch. */
  noteClear(): void;
  dispose(): void;
  /** Records emitted across all epochs. */
  exportedLines(): number;
  /** Newest exported absLine of the current epoch, or null. */
  lastExportedAbsLine(): number | null;
}

// xterm 6.0's content/attribute word layout (common/buffer/Constants.ts),
// the same constants src/semanticPaint.ts relies on.
const CODEPOINT_MASK = 0x1fffff;
const IS_COMBINED_MASK = 0x200000;
const HAS_CONTENT_MASK = 0x3fffff;
const WIDTH_MASK = 0xc00000;
const WIDTH_SHIFT = 22;
const CM_MASK = 0x3000000;
const RGB_MASK = 0xffffff;
const FG_INVERSE = 0x4000000;
const FG_BOLD = 0x8000000;
const FG_UNDERLINE = 0x10000000;
const FG_BLINK = 0x20000000;
const FG_INVISIBLE = 0x40000000;
const FG_STRIKE = 0x80000000;
const BG_ITALIC = 0x4000000;
const BG_DIM = 0x8000000;

/** The private side of a buffer line, re-read on every call like painting. */
interface RowInternals {
  _data: Uint32Array;
  _combined?: Record<number, string>;
  length: number;
}

function rowInternals(line: IBufferLine): RowInternals | null {
  const inner = (line as unknown as { _line?: RowInternals })?._line;
  if (!inner || !(inner._data instanceof Uint32Array)) return null;
  if (!Number.isInteger(inner.length) || inner.length < 0) return null;
  if (inner._data.length !== inner.length * 3) return null;
  return inner;
}

/** History cells from one physical row; wide characters span two cells. */
function cellSource(line: IBufferLine): CellSource | null {
  const inner = rowInternals(line);
  if (!inner) return null;
  const data = inner._data;
  const combined = inner._combined;
  return {
    length: inner.length,
    cellAt: (col) => {
      const base = col * 3;
      const content = data[base];
      const width = (content & WIDTH_MASK) >>> WIDTH_SHIFT;
      if (!(content & HAS_CONTENT_MASK)) {
        return {
          char: width === 0 ? "" : " ",
          width,
          fg: DEFAULT_COLOR,
          bg: DEFAULT_COLOR,
          flags: 0,
        };
      }
      const fg = data[base + 1];
      const bg = data[base + 2];
      const codepoint = content & CODEPOINT_MASK;
      const char =
        content & IS_COMBINED_MASK && combined?.[col] !== undefined
          ? combined[col]
          : String.fromCodePoint(codepoint);
      return { char, width, fg: packColor(fg), bg: packColor(bg), flags: packFlags(fg, bg) };
    },
  };
}

/** xterm's packed color word → the history packing (default sentinel). */
function packColor(word: number): number {
  return (word & CM_MASK) === 0 ? DEFAULT_COLOR : (word & (CM_MASK | RGB_MASK)) >>> 0;
}

/** xterm's scattered style bits → the contract's 8 flag bits. */
function packFlags(fg: number, bg: number): number {
  return (
    (fg & FG_BOLD ? 1 : 0) |
    (bg & BG_DIM ? 2 : 0) |
    (bg & BG_ITALIC ? 4 : 0) |
    (fg & FG_UNDERLINE ? 8 : 0) |
    (fg & FG_BLINK ? 16 : 0) |
    (fg & FG_INVERSE ? 32 : 0) |
    (fg & FG_INVISIBLE ? 64 : 0) |
    (fg & FG_STRIKE ? 128 : 0)
  );
}

export function createHistoryCapture(
  terminal: Terminal,
  options: HistoryCaptureOptions,
): HistoryCapture {
  const ratio = options.scrollbackMarginRatio ?? 0.1;
  const lineTimeAt = options.lineTimeAt ?? (() => null);
  let exportedThroughAbs = 0;
  let emitted = 0;
  let frontierRow = 0;
  let marker: IMarker | null = null;
  let resyncPending = false;
  let disposed = false;
  const exportedTexts = new Set<string>();
  const resizeListener = terminal.onResize(() => {
    // Reflow re-wraps rows and can delete marker lines; relocate lazily.
    resyncPending = true;
    marker?.dispose();
    marker = null;
  });

  const parkMarker = (row: number) => {
    marker?.dispose();
    const buffer = terminal.buffer.active;
    marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY)) ?? null;
  };

  /** The visible text of the logical line spanning [head, end]. */
  const logicalText = (head: number, end: number): string => {
    const buffer = terminal.buffer.active;
    let text = "";
    for (let row = head; row <= end; row++) {
      text += buffer.getLine(row)?.translateToString(true) ?? "";
    }
    return text;
  };

  /**
   * After a resize: walk logical lines from the bottom; the first one that
   * is already exported marks the boundary — everything below it is
   * unexported, and the frontier is that next line's head. If no exported
   * line survived the reflow trim, the whole buffer is unexported.
   */
  const resyncFrontier = () => {
    resyncPending = false;
    const buffer = terminal.buffer.active;
    let candidate = 0;
    let end = buffer.length - 1;
    while (end >= 0) {
      let head = end;
      while (head > 0 && (buffer.getLine(head)?.isWrapped ?? false)) head -= 1;
      const text = logicalText(head, end);
      if (text !== "" && exportedTexts.has(text)) {
        frontierRow = candidate;
        return;
      }
      candidate = head;
      end = head - 1;
    }
    frontierRow = 0;
  };

  const notifyWriteParsed = () => {
    if (disposed) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal") return;
    if (resyncPending) {
      resyncFrontier();
    } else if (marker?.isDisposed) {
      // The trim caught up with the frontier itself: unexported lines were
      // lost. Keep numbering continuous for what survives; never re-export.
      options.onMismatch?.("trim reached the export frontier before the next write was observed");
      marker = null;
      frontierRow = 0;
    } else if (marker) {
      frontierRow = marker.line;
    }
    const scrollback = terminal.options.scrollback ?? 0;
    if (scrollback <= 0) return;
    const marginRows = Math.max(1, Math.ceil(scrollback * ratio));
    const capacity = terminal.rows + scrollback;
    if (capacity - buffer.length >= marginRows) {
      // Trims are still impossible; arm the frontier marker once a screenful
      // is in the buffer (terminalLineGutter's threshold).
      if (!marker && buffer.length > scrollback) parkMarker(frontierRow);
      return;
    }
    // Near the limit: export complete logical lines that sit fully above the
    // trailing margin band. The buffer's last line is still growing and is
    // never exported.
    const limitRow = buffer.length - marginRows;
    const records: HistoryRecord[] = [];
    let row = frontierRow;
    while (row < limitRow) {
      const sources: CellSource[] = [];
      let endRow = row;
      while (endRow < buffer.length) {
        const line = buffer.getLine(endRow);
        const source = line ? cellSource(line) : null;
        if (!source) {
          options.onMismatch?.("xterm buffer internals unavailable during export");
          return;
        }
        sources.push(source);
        endRow += 1;
        const next = buffer.getLine(endRow);
        if (!next || !next.isWrapped) break;
      }
      if (endRow > limitRow) break;
      const absLine = exportedThroughAbs + records.length + 1;
      records.push(logicalLineFromCells(sources, { absLine, timeMs: lineTimeAt(absLine) ?? 0 }));
      row = endRow;
    }
    if (records.length > 0) {
      options.onBatch(encodeHistoryBatch(records));
      exportedThroughAbs += records.length;
      emitted += records.length;
      for (const record of records) exportedTexts.add(record.text);
      frontierRow = row;
    }
    parkMarker(frontierRow);
  };

  // Park at the initial frontier (row 0) immediately: a flood of writes
  // without any notifyWriteParsed in between must still be detectable.
  parkMarker(0);

  return {
    notifyWriteParsed,
    noteClear: () => {
      marker?.dispose();
      marker = null;
      resyncPending = false;
      exportedThroughAbs = 0;
      frontierRow = 0;
      exportedTexts.clear();
      parkMarker(0);
    },
    dispose: () => {
      disposed = true;
      marker?.dispose();
      marker = null;
      resizeListener.dispose();
    },
    exportedLines: () => emitted,
    lastExportedAbsLine: () => (exportedThroughAbs > 0 ? exportedThroughAbs : null),
  };
}
