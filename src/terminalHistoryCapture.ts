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
 * schedules a resync. The count of *unexported logical lines through the
 * cursor* is invariant under a synchronous reflow, even when every log line
 * has the same text. Relocate the frontier by counting those logical lines
 * backward from the cursor, without interpreting content or allocating a
 * potentially unbounded set of previous line texts.
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
  /** Legacy logical-line clock; preferably use the physical-row clock below. */
  lineTimeAt?: (absLine: number) => number | null;
  /** Epoch time at the head physical row of an exported logical line. */
  lineTimeAtRow?: (bufferRow: number) => number | null;
  onBatch: (bytes: Uint8Array) => void;
  onMismatch?: (detail: string) => void;
}

export interface HistoryCapture {
  /** Call from xterm's onWriteParsed hook. */
  notifyWriteParsed(): void;
  /** Call when the terminal is cleared: starts a new numbering epoch. */
  noteClear(): void;
  /**
   * Call after seamless history re-inserted `count` rows above the buffer
   * top: the frontier re-parks `count` rows lower so those already exported
   * rows can never be exported again.
   */
  notePrepended(count: number): void;
  dispose(): void;
  /** Records emitted across all epochs. */
  exportedLines(): number;
  /** Newest exported absLine of the current epoch, or null. */
  lastExportedAbsLine(): number | null;
  /**
   * The oldest exported logical record with physical rows still in xterm's
   * hot buffer. Also an exclusive upper bound for fetching older records.
   * If none remains in hot, returns newestExportedAbsLine + 1. Returns null
   * before any export or while the marker cannot establish the boundary.
   */
  oldestBufferedExportedAbsLine(): number | null;
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
  const lineTimeAtRow = options.lineTimeAtRow;
  let exportedThroughAbs = 0;
  let lastExportedTimeMs = 0;
  let emitted = 0;
  let frontierRow = 0;
  let marker: IMarker | null = null;
  let resyncPending = false;
  let unexportedToCursor: number | null = 1;
  let halted = false;
  let disposed = false;
  // The hot buffer can begin with the wrapped tail of a partially trimmed
  // logical line. Prepending older whole records puts a new logical line just
  // before that tail, although its isWrapped bit remains true. Remember that
  // insertion seam by the underlying BufferLine identity (which travels
  // through splices/trims), so page-boundary counting does not merge them.
  // TODO(A2): a hot buffer whose first row is only a wrapped tail still lacks
  // the trimmed prefix of that logical line. Restoring the prefix requires
  // merging it with the tail, not inserting another whole copy of the line.
  const prependSeamHeads = new WeakSet<object>();
  const resizeListener = terminal.onResize(() => {
    // Capture the reflow seam synchronously, *before* the next PTY write. A
    // deferred relocation would silently skip any lines received between the
    // resize and the next onWriteParsed callback.
    marker?.dispose();
    marker = null;
    resyncFrontier();
    if (!halted) {
      if (terminal.buffer.active.type === "normal") parkMarker(frontierRow);
      rememberFrontierDistance();
    }
    // Suppress cold reads until the next parsed write verifies the seam.
    resyncPending = true;
  });
  const bufferListener = terminal.buffer.onBufferChange((buffer) => {
    if (resyncPending && buffer.type === "normal" && !halted && !marker) {
      // Returning from alternate screen can be followed by shell output in
      // the same write. Reinstall *during* the switch, before those bytes
      // can trim the already relocated normal-buffer frontier.
      parkMarker(frontierRow);
    }
  });

  const parkMarker = (row: number) => {
    marker?.dispose();
    const buffer = terminal.buffer.active;
    marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY)) ?? null;
  };

  /** Snapshot the logical distance from the frontier to the live cursor. */
  const rememberFrontierDistance = () => {
    const buffer = terminal.buffer.normal;
    const cursor = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
    if (frontierRow < 0 || cursor < frontierRow) {
      unexportedToCursor = null;
      return;
    }
    let count = 0;
    for (let row = frontierRow; row <= cursor; row++) {
      const line = buffer.getLine(row);
      if (!line) {
        unexportedToCursor = null;
        return;
      }
      if (row === frontierRow || !line.isWrapped) count++;
    }
    unexportedToCursor = count;
  };

  /**
   * After reflow, the live cursor still belongs to the same logical line.
   * Walk backward over the previously observed number of unexported logical
   * lines; matching content alone is unsafe for repeated build/progress logs.
   */
  const resyncFrontier = () => {
    resyncPending = false;
    const buffer = terminal.buffer.normal;
    const cursor = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
    if (unexportedToCursor === null || unexportedToCursor <= 0 || cursor < 0) {
      options.onMismatch?.("resize cannot locate the export frontier from the cursor");
      halted = true;
      return;
    }
    let head = cursor;
    while (head > 0 && buffer.getLine(head)?.isWrapped) head--;
    for (let remaining = unexportedToCursor - 1; remaining > 0; remaining--) {
      head--;
      if (head < 0) {
        options.onMismatch?.("resize trimmed the unexported frontier");
        halted = true;
        return;
      }
      while (head > 0 && buffer.getLine(head)?.isWrapped) head--;
    }
    frontierRow = head;
  };

  const notifyWriteParsed = () => {
    if (disposed || halted) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal") return;
    if (resyncPending) {
      // Relocated synchronously by onResize; if it happened while alternate
      // screen was active, onBufferChange restores the normal marker before
      // the first subsequent normal-buffer byte gets parsed.
      resyncPending = false;
      if (!marker) {
        options.onMismatch?.("resized export frontier marker was not restored");
        halted = true;
        return;
      }
      if (marker?.isDisposed) {
        options.onMismatch?.("trim reached the resized export frontier before the next write");
        halted = true;
        return;
      }
      if (marker) frontierRow = marker.line;
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
      rememberFrontierDistance();
      return;
    }
    // Near the limit: export complete logical lines that sit fully above the
    // trailing margin band. The buffer's last line is still growing and is
    // never exported.
    const limitRow = buffer.length - marginRows;
    const records: HistoryRecord[] = [];
    let batchLastTimeMs = lastExportedTimeMs;
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
      // The history index is in logical lines; the gutter's timestamps live
      // in physical rows, so read the head row before advancing the frontier.
      // A cursor-addressed repaint can date an older row after newer rows;
      // clamp to the previous export to preserve the history codec's ordered
      // timestamps (including across batch boundaries).
      const observed = lineTimeAtRow?.(row) ?? lineTimeAt(absLine);
      const validTime =
        observed != null && Number.isSafeInteger(observed) && observed > 0 ? observed : 0;
      batchLastTimeMs = Math.max(batchLastTimeMs, validTime);
      records.push(logicalLineFromCells(sources, { absLine, timeMs: batchLastTimeMs }));
      row = endRow;
    }
    if (records.length > 0) {
      options.onBatch(encodeHistoryBatch(records));
      lastExportedTimeMs = batchLastTimeMs;
      exportedThroughAbs += records.length;
      emitted += records.length;
      frontierRow = row;
    }
    parkMarker(frontierRow);
    rememberFrontierDistance();
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
      unexportedToCursor = 1;
      halted = false;
      exportedThroughAbs = 0;
      lastExportedTimeMs = 0;
      frontierRow = 0;
      parkMarker(0);
    },
    notePrepended: (count: number) => {
      // Native markers follow CircularList insertions, but our cached
      // frontierRow does not. Re-park against the known physical insertion
      // count so already-exported cold rows cannot be re-exported.
      if (disposed || count <= 0) return;
      const carried = terminal.buffer.normal.getLine(count);
      if (carried?.isWrapped) {
        const inner = (carried as unknown as { _line?: object })._line;
        if (inner) prependSeamHeads.add(inner);
      }
      marker?.dispose();
      marker = null;
      frontierRow += count;
      parkMarker(frontierRow);
      rememberFrontierDistance();
    },
    dispose: () => {
      disposed = true;
      marker?.dispose();
      marker = null;
      resizeListener.dispose();
      bufferListener.dispose();
    },
    exportedLines: () => emitted,
    lastExportedAbsLine: () => (exportedThroughAbs > 0 ? exportedThroughAbs : null),
    oldestBufferedExportedAbsLine: () => {
      if (disposed || halted || exportedThroughAbs === 0 || resyncPending) return null;
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal" || !marker || marker.isDisposed) return null;
      const frontier = marker.line;
      if (!Number.isInteger(frontier) || frontier < 0 || frontier > buffer.length) return null;
      // The first row may be a wrapped tail of a line trimmed at the top.
      // It is still resident and must not be reinserted as a duplicate.
      let resident = frontier > 0 ? 1 : 0;
      for (let row = 1; row < frontier; row++) {
        const line = buffer.getLine(row);
        if (!line) return null;
        const inner = (line as unknown as { _line?: object })._line;
        if (!line.isWrapped || (inner && prependSeamHeads.has(inner))) resident++;
      }
      if (resident > exportedThroughAbs) return null;
      return exportedThroughAbs - resident + 1;
    },
  };
}
