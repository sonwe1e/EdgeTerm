import { Terminal, type IBuffer, type IBufferCell } from "@xterm/xterm";
import { semanticLine, shellPromptEnd } from "./semanticColors";
import {
  canPaint,
  internalLine,
  paintBackground,
  paintForeground,
  paintable,
  rgb,
  rowIsBlank,
  rowSignature,
  unpaint,
  type PaintLine,
} from "./semanticPaint";
import { BACKLOG_QUIET_MS, BACKLOG_SLICE_MS, PaintRecord } from "./terminalShared";

interface Context {
  readonly term: Terminal;
  readonly visible: boolean;
  readonly disposed: boolean;
}

export class TerminalSemanticRenderer {
  /**
   * Each visited row's signature and cursor state, keyed by xterm's line
   * object (see refreshSemanticColors). A WeakMap lets trimmed rows take
   * their records with them.
   */
  private paintRecords = new WeakMap<PaintLine, PaintRecord>();

  /** Whether xterm's buffer layout allows painting; null until checked. */
  private paintSupported: boolean | null = null;

  /** The backlog pass's next slice or its quiet wait; see scheduleBacklog. */
  private backlogTimer: number | null = null;

  /** Where the backlog walk resumes, walking up; null starts at the bottom. */
  private backlogRow: number | null = null;

  /** Reused cell for buffer walks, to avoid per-cell allocation. */
  workCell: IBufferCell | undefined;

  /**
   * WindTerm-style semantic coloring for output that did not set its own ANSI
   * colors, painted into the buffer cells (see semanticPaint.ts) so a row
   * keeps its colors into the scrollback, through trimming and reflow, on
   * either renderer (issue #80). `paintRecords` holds each row's signature
   * and cursor state, keyed by xterm's line object, so a row is only read
   * again once its text, paint or cursor state has changed.
   *
   * This pass covers the viewport and runs from the write, scroll and render
   * hooks, each timed before the paint it affects; an idle screen costs one
   * signature per row. Rows an output flood scrolls away before they are
   * ever on screen are left to the backlog pass (`scheduleBacklog`).
   */
  refreshSemanticColors() {
    if (this.context.term.rows === 0 || !this.semanticPaintReady()) return;
    const buf = this.context.term.buffer.active;
    const top = buf.viewportY;
    const bottom = Math.min(top + this.context.term.rows - 1, buf.length - 1);
    let first = Infinity;
    let last = -Infinity;
    let row = top;
    while (row <= bottom) {
      const [lo, hi] = this.logicalLine(buf, row);
      row = hi + 1;
      if (this.paintLogicalLine(buf, lo, hi)) {
        first = Math.min(first, lo);
        last = Math.max(last, hi);
      }
    }
    this.refreshPaintedRows(first, last);
  }

  /**
   * Cell writes do not mark rows dirty, so painted rows in view are queued
   * for a repaint (debounced by xterm to the next frame).
   */
  private refreshPaintedRows(first: number, last: number) {
    const top = this.context.term.buffer.active.viewportY;
    const start = Math.max(first - top, 0);
    const end = Math.min(last - top, this.context.term.rows - 1);
    if (start <= end) this.context.term.refresh(start, end);
  }

  /** Rows [first, last] of the logical line through `row`, across soft wraps. */
  private logicalLine(buf: IBuffer, row: number): [number, number] {
    let first = row;
    while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;
    let last = row;
    while (buf.getLine(last + 1)?.isWrapped) last += 1;
    return [first, last];
  }

  /**
   * Recolors one logical line if any of its rows changed since it was last
   * colored; returns whether any cell changed.
   */
  private paintLogicalLine(buf: IBuffer, first: number, last: number): boolean {
    const lines: PaintLine[] = [];
    const cursor = buf.baseY + buf.cursorY;
    const onCursorLine = first <= cursor && cursor <= last;
    let changed = false;
    for (let row = first; row <= last; row += 1) {
      const line = internalLine(buf.getLine(row));
      if (!line) return false;
      lines.push(line);
      if (!changed) {
        const recorded = this.paintRecords.get(line);
        changed =
          recorded === undefined
            ? onCursorLine || !rowIsBlank(line)
            : recorded.cursor !== onCursorLine || recorded.signature !== rowSignature(line);
      }
    }
    if (!changed) return false;

    let cleared = 0;
    for (const line of lines) {
      cleared += unpaint(line);
    }
    // A live shell prompt has a stable prefix worth coloring. Other cursor
    // lines (echoed input, progress bars, full-screen redraws) stay plain.
    const painted = this.colorLogicalLine(buf, first, last, lines, onCursorLine);
    for (const line of lines) {
      this.paintRecords.set(line, { signature: rowSignature(line), cursor: onCursorLine });
    }
    return cleared > 0 || painted;
  }

  /**
   * Paints one logical line (rows [first..last] joined across soft wraps).
   * The text is rebuilt from cells with a string-index → column map so spans
   * align across wide (CJK) glyphs and wrapped rows instead of assuming one
   * column per code unit.
   */
  private colorLogicalLine(
    buf: IBuffer,
    first: number,
    last: number,
    lines: PaintLine[],
    onCursorLine: boolean,
  ): boolean {
    const work = (this.workCell ??= buf.getNullCell());

    let text = "";
    const rows: number[] = [];
    const cols: number[] = [];
    const widths: number[] = [];
    for (let row = first; row <= last && text.length <= 4000; row += 1) {
      const line = buf.getLine(row);
      if (!line) break;
      for (let col = 0; col < line.length; ) {
        const cell = line.getCell(col, work);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) {
          col += 1;
          continue;
        }
        const chars = cell.getChars() || " ";
        for (let i = 0; i < chars.length; i += 1) {
          rows.push(row);
          cols.push(col);
          widths.push(width);
        }
        text += chars;
        col += width;
      }
    }
    text = text.replace(/\s+$/, "");
    // Pathological logical lines (minified assets, base64 blobs) are not
    // worth the regex cost; they are still recorded so they are not
    // examined again.
    if (!text || text.length > 4000) return false;
    if (onCursorLine) {
      const promptEnd = shellPromptEnd(text);
      if (promptEnd < 0) return false;
      text = text.slice(0, promptEnd);
    }
    const { ranges, band } = semanticLine(text);

    // A line band tints whole rows that carry no styling of their own. Not
    // on the alternate screen: a full-screen program lays out its own rows,
    // and a band behind one of them reads as part of its UI.
    if (band && !onCursorLine && buf.type === "normal") {
      const color = rgb(band);
      for (const line of lines) {
        if (canPaint(line, 0, line.length)) {
          paintBackground(line, 0, line.length, color);
        }
      }
    }

    for (const range of ranges) {
      // A range that crosses a soft wrap is painted row by row.
      let start = range.start;
      while (start < range.end) {
        const row = rows[start];
        let end = start;
        while (end < range.end && rows[end] === row) end += 1;
        const startCol = cols[start];
        const endCol = cols[end - 1] + widths[end - 1];
        start = end;

        const line = lines[row - first];
        if (!line || !canPaint(line, startCol, endCol)) continue;
        // A pill's ground (serialX's HTTP methods).
        if (range.background) {
          paintBackground(line, startCol, endCol, rgb(range.background));
        }
        paintForeground(line, startCol, endCol, rgb(range.color), !!range.underline);
      }
    }
    return ranges.length > 0 || !!band;
  }

  /** Whether cells can be painted on this xterm; checked once. */
  private semanticPaintReady(): boolean {
    if (this.paintSupported === null) {
      this.paintSupported = paintable(this.context.term);
      if (!this.paintSupported) {
        console.warn("xterm's buffer layout changed; semantic coloring is off");
      }
    }
    return this.paintSupported;
  }

  /**
   * Drops every row's record, so every row is colored again: after a theme
   * switch (new palette) or a resize (reflow rebuilds rows, and a band ends
   * at the old width). The viewport is redone now, the rest in the backlog.
   */
  recolorAll() {
    this.paintRecords = new WeakMap();
    // A hidden terminal repaints when it is shown (see setVisible).
    if (this.context.visible) this.refreshSemanticColors();
    this.scheduleBacklog();
  }

  /**
   * Colors the rest of the normal buffer once output has been quiet for
   * BACKLOG_QUIET_MS: walking up from the newest row in slices of
   * BACKLOG_SLICE_MS, so it never holds up input or rendering. Any new output
   * restarts the walk from the bottom — rows already colored cost one
   * signature each, so the restart only repeats the cheap part. Only a
   * visible normal buffer runs it; showing one or returning from a full-screen
   * program starts it.
   */
  scheduleBacklog() {
    this.backlogRow = null;
    if (this.backlogTimer !== null) window.clearTimeout(this.backlogTimer);
    this.backlogTimer = null;
    if (
      this.context.disposed ||
      !this.context.visible ||
      this.context.term.buffer.active.type !== "normal"
    )
      return;
    this.backlogTimer = window.setTimeout(() => this.runBacklog(), BACKLOG_QUIET_MS);
  }

  private runBacklog() {
    this.backlogTimer = null;
    if (
      this.context.disposed ||
      !this.context.visible ||
      this.context.term.buffer.active.type !== "normal" ||
      !this.semanticPaintReady()
    )
      return;
    const buf = this.context.term.buffer.normal;
    const deadline = performance.now() + BACKLOG_SLICE_MS;
    let row = Math.min(this.backlogRow ?? Infinity, buf.length - 1);
    let first = Infinity;
    let last = -Infinity;
    while (row >= 0 && performance.now() < deadline) {
      const [lo, hi] = this.logicalLine(buf, row);
      if (this.paintLogicalLine(buf, lo, hi)) {
        first = Math.min(first, lo);
        last = Math.max(last, hi);
      }
      row = lo - 1;
    }
    if (this.context.term.buffer.active.type === "normal") this.refreshPaintedRows(first, last);
    if (row < 0) {
      this.backlogRow = null;
      return;
    }
    this.backlogRow = row;
    this.backlogTimer = window.setTimeout(() => this.runBacklog(), 0);
  }

  stopBacklog() {
    if (this.backlogTimer !== null) window.clearTimeout(this.backlogTimer);
    this.backlogTimer = null;
    this.backlogRow = null;
  }
  constructor(private readonly context: Context) {}
}
