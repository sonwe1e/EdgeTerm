import { Terminal, type IMarker } from "@xterm/xterm";
import { GutterMode, GutterView, LINE_TIME_SLACK, formatTime } from "./terminalShared";

interface Context {
  readonly gutter: HTMLElement | null;
  readonly gutterMode: GutterMode;
  readonly term: Terminal;
  readonly scrollback: number;
  readonly host: HTMLElement | null;
}

export class TerminalLineGutter {
  rowPool: HTMLElement[] = [];

  /** Wall-clock time each buffer line was produced, parallel to buffer lines. */
  lineTimes: number[] = [];

  /**
   * Where buffer line 0 sits in `lineTimes`. Lines xterm has trimmed are
   * skipped rather than spliced off the front, which on a full 20 000-line
   * scrollback would move the whole array once per line of output; the slack
   * is compacted away in batches instead.
   */
  private lineTimesStart = 0;

  /** Absolute line number of buffer line 0; grows as scrollback is trimmed. */
  firstLineNumber = 1;

  /** Parked in the buffer to measure the trimming; see `followTrimmedLines`. */
  private trimMarker: IMarker | null = null;

  /** The line `trimMarker` was last seen on. */
  private trimMarkerLine = 0;

  /**
   * Cached so the per-frame gutter sync never reads layout. Recomputed only on
   * fit/resize, which is the only time it can change.
   */
  cellHeight = 0;

  /**
   * The xterm-owned state the gutter rows were last painted for. A paint
   * that matches it is skipped: a selection drag re-renders every frame
   * without moving the viewport or cursor. This class's own inputs to the
   * rows (line times, line numbering, mode) are covered by `invalidateGutter`
   * at their mutation sites instead of being compared here.
   */
  private gutterPainted: GutterView | null = null;

  /** Output may have changed the last nonblank screen row without moving the cursor. */
  gutterContentDirty = true;

  applyGutterMode() {
    if (!this.context.gutter) return;
    this.context.gutter.classList.toggle("is-hidden", this.context.gutterMode === "off");
    this.context.gutter.classList.toggle(
      "no-time",
      this.context.gutterMode === "line" || this.context.gutterMode === "off",
    );
    this.context.gutter.classList.toggle(
      "no-line",
      this.context.gutterMode === "time" || this.context.gutterMode === "off",
    );
  }

  recordLine() {
    // The line feed that produced this row may have been the one that dropped
    // the oldest, which moves every index the times are keyed by.
    this.followTrimmedLines();
    const buf = this.context.term.buffer.active;
    const at = this.lineTimesStart + buf.baseY + buf.cursorY;
    const now = Date.now();
    while (this.lineTimes.length <= at) this.lineTimes.push(now);
    this.lineTimes[at] = now;
    this.invalidateGutter();
    this.trimLineMetadata();
  }

  /** Line times held, i.e. how many buffer lines from the top have one. */
  get lineCount(): number {
    return this.lineTimes.length - this.lineTimesStart;
  }

  setLineTimes(times: number[]) {
    this.lineTimes = times;
    this.lineTimesStart = 0;
  }

  trimLineMetadata() {
    const max = this.context.term.rows + this.context.scrollback;
    this.dropLeadingLines(this.lineCount - max);
  }

  /** xterm dropped `count` lines off the top; carry them into the numbering. */
  dropLeadingLines(count: number) {
    if (count <= 0) return;
    this.lineTimesStart = Math.min(this.lineTimes.length, this.lineTimesStart + count);
    this.firstLineNumber += count;
    // Compact in batches so the copy costs a few elements per dropped line.
    if (this.lineTimesStart >= LINE_TIME_SLACK) {
      this.setLineTimes(this.lineTimes.slice(this.lineTimesStart));
    }
    this.invalidateGutter();
  }

  /**
   * Once the buffer is full every line xterm appends drops the oldest one,
   * and nothing reports it: a line feed at the bottom recycles the top line
   * instead of growing the buffer, so `recordLine` keeps landing on the same
   * index and the numbering would freeze at the line the scrollback filled up
   * on. A marker parked in the buffer measures the drop exactly — markers
   * ride down with the trim — so everything that reads or writes the line
   * metadata starts here. It is re-parked as the trim catches up with it,
   * and dropped by the erases and resizes that account for their own.
   */
  followTrimmedLines() {
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal") return;
    const marker = this.trimMarker;
    if (marker && !marker.isDisposed) {
      this.dropLeadingLines(this.trimMarkerLine - marker.line);
      this.trimMarkerLine = marker.line;
      // Still above the trim; the next line it drops keeps it valid.
      if (marker.line > 0) return;
      marker.dispose();
    }
    // Nothing can be trimmed while a screenful still fits: no marker needed
    // yet, and parking one per line would cost more than it measures.
    if (buf.length <= this.context.scrollback) {
      this.trimMarker = null;
      return;
    }
    this.trimMarker = this.context.term.registerMarker(0);
    this.trimMarkerLine = this.trimMarker?.line ?? 0;
  }

  /** Park a fresh marker: the caller has accounted for the trim itself. */
  resetTrimMarker() {
    this.trimMarker?.dispose();
    this.trimMarker = null;
  }

  /**
   * `.xterm-screen` spans exactly `rows` cells, so its height divided by the
   * row count is the exact cell height — no reaching into xterm's renderer.
   */
  measureCell() {
    const screen = this.context.host?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || this.context.term.rows === 0) return;
    const height = screen.clientHeight / this.context.term.rows;
    if (Number.isFinite(height) && height > 0 && height !== this.cellHeight) {
      this.cellHeight = height;
      // Rows size themselves from this, so a height change costs one style
      // write here instead of two per row on every sync.
      this.context.gutter?.style.setProperty("--gutter-cell", `${height}px`);
    }
  }

  /** Marks the gutter rows stale; the next sync repaints unconditionally. */
  invalidateGutter() {
    this.gutterPainted = null;
  }

  syncGutter() {
    // Output that scrolled without a line feed (a full-screen program's erase)
    // may have trimmed the buffer since the last pass.
    this.followTrimmedLines();
    if (!this.context.gutter || !this.context.host || this.context.gutterMode === "off") return;
    if (this.cellHeight <= 0) this.measureCell();
    if (this.cellHeight <= 0) return;

    const buf = this.context.term.buffer.active;
    const viewportY = buf.viewportY;
    const cursorIndex = buf.baseY + buf.cursorY;
    const rows = this.context.term.rows;
    // Full-screen programs (vim, top) paint into the alternate buffer, where
    // line numbers and produced-at times are meaningless.
    const alternate = buf.type === "alternate";
    const painted = this.gutterPainted;
    const sameView = !!(
      painted &&
      painted.viewportY === viewportY &&
      painted.cursorIndex === cursorIndex &&
      painted.rows === rows &&
      painted.alternate === alternate
    );
    if (sameView && !this.gutterContentDirty) return;
    this.gutterContentDirty = false;

    // A line feed can fill the timestamp array across untouched blank rows,
    // and a program can move the cursor back after visiting a lower row.
    // Keep meaningful blank lines inside the history, but hide only the
    // blank suffix below both the cursor and the last visible text.
    let contentEnd = cursorIndex;
    if (!alternate) {
      for (let index = buf.baseY + rows - 1; index > cursorIndex; index -= 1) {
        if (buf.getLine(index)?.translateToString(true).length) {
          contentEnd = index;
          break;
        }
      }
    }
    if (sameView && painted?.contentEnd === contentEnd) return;
    this.gutterPainted = { viewportY, cursorIndex, contentEnd, rows, alternate };

    while (this.rowPool.length < rows) {
      const row = document.createElement("div");
      row.className = "gutter-row";
      const time = document.createElement("span");
      time.className = "gutter-time";
      const line = document.createElement("span");
      line.className = "gutter-line";
      row.append(time, line);
      this.context.gutter.appendChild(row);
      this.rowPool.push(row);
    }
    while (this.rowPool.length > rows) {
      this.rowPool.pop()?.remove();
    }

    for (let i = 0; i < rows; i++) {
      const row = this.rowPool[i];
      const index = viewportY + i;

      // `buf.length` spans the viewport, and line feeds can put timestamps
      // on padding rows. The content limit keeps that blank suffix hidden.
      const written = !alternate && index < this.lineCount && index <= contentEnd;
      row.classList.toggle("is-empty", !written);
      row.classList.toggle("is-cursor", written && index === cursorIndex);

      const time = row.children[0] as HTMLElement;
      const line = row.children[1] as HTMLElement;
      if (written) {
        time.textContent = formatTime(this.lineTimes[this.lineTimesStart + index]);
        line.textContent = String(this.firstLineNumber + index);
      } else {
        time.textContent = "";
        line.textContent = "";
      }
    }
  }
  constructor(private readonly context: Context) {}
}
