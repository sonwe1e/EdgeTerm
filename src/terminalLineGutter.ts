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
  private screenText = new Map<number, string>();
  private lastProducedLine = 0;

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
    if (this.context.term.buffer.active.type !== "normal") return;
    // The line feed that produced this row may have been the one that dropped
    // the oldest, which moves every index the times are keyed by.
    this.followTrimmedLines();
    const buf = this.context.term.buffer.active;
    const at = this.lineTimesStart + buf.baseY + buf.cursorY;
    const now = Date.now();
    while (this.lineTimes.length <= at) this.lineTimes.push(now);
    // A cursor-addressed repaint (notably ConPTY after resize) visits old
    // rows with LF too. Visiting a row does not produce a new line.
    this.recordNewRows(buf.baseY + buf.cursorY, now);
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

  private recordNewRows(index: number, now: number) {
    const end = this.firstLineNumber + index;
    if (end <= this.lastProducedLine) return;
    const start = Math.max(0, this.lastProducedLine - this.firstLineNumber + 1);
    for (let row = start; row <= index; row++) this.lineTimes[this.lineTimesStart + row] = now;
    this.lastProducedLine = end;
    this.invalidateGutter();
  }

  /** Update rewritten/previously blank rows without dating an identical repaint. */
  outputParsed() {
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal") return;
    this.followTrimmedLines();
    const next = new Map<number, string>();
    let contentEnd = buf.baseY + buf.cursorY;
    for (let i = buf.baseY; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      const key = this.firstLineNumber + i;
      const previous = this.screenText.get(key);
      next.set(key, text);
      if (!text) continue;
      contentEnd = Math.max(contentEnd, i);
      this.recordNewRows(i, Date.now());
      const at = this.lineTimesStart + i;
      while (this.lineTimes.length <= at) this.lineTimes.push(Date.now());
      if (
        previous !== undefined &&
        previous !== text &&
        (!previous || !text.startsWith(previous))
      ) {
        this.lineTimes[at] = Date.now();
        this.invalidateGutter();
      }
    }
    this.screenText = next;
    // ConPTY may visit padding with LF and then move back to its prompt.
    // Those blank tail rows have not produced output yet.
    this.lastProducedLine = this.firstLineNumber + contentEnd;
  }

  resetOutputTracking() {
    const buf = this.context.term.buffer.normal;
    this.lastProducedLine = this.firstLineNumber + buf.baseY + buf.cursorY;
    this.screenText.clear();
    for (let i = buf.baseY; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      this.screenText.set(this.firstLineNumber + i, text);
      if (text) this.lastProducedLine = Math.max(this.lastProducedLine, this.firstLineNumber + i);
    }
  }

  /** Reflow changes physical row indices. Carry times by ordered logical lines. */
  resize(cols: number, resize: () => void) {
    const term = this.context.term;
    if (term.cols === cols) {
      resize();
      return;
    }
    this.followTrimmedLines();
    const logical = () => {
      const groups: { text: string; rows: { index: number; offset: number; time: number }[] }[] =
        [];
      const buf = term.buffer.normal;
      let end = buf.baseY + buf.cursorY;
      for (let i = buf.length - 1; i > end; i--) {
        if (buf.getLine(i)?.translateToString(true)) {
          end = i;
          break;
        }
      }
      // Unused screen padding has no produced-at identity. Including it
      // would match real blank output with these later empty rows.
      for (let i = 0; i <= end; i++) {
        const line = buf.getLine(i)!;
        if (!line.isWrapped || !groups.length) groups.push({ text: "", rows: [] });
        const group = groups[groups.length - 1];
        group.rows.push({
          index: i,
          offset: group.text.length,
          time: this.lineTimes[this.lineTimesStart + i],
        });
        group.text += line.translateToString(!buf.getLine(i + 1)?.isWrapped);
      }
      return groups;
    };
    const before = logical();
    resize();
    const after = logical();
    // Match from the newest end: narrowing a full buffer can trim older
    // occurrences of identical log lines. They must not date the survivors.
    const queues = new Map<string, typeof before>();
    for (const group of before) {
      const queue = queues.get(group.text) ?? [];
      queue.push(group);
      queues.set(group.text, queue);
    }
    const times: number[] = [];
    for (let index = after.length - 1; index >= 0; index--) {
      const group = after[index];
      const old = queues.get(group.text)?.pop();
      let sourceIndex = 0;
      for (const row of group.rows) {
        while (
          old &&
          sourceIndex + 1 < old.rows.length &&
          old.rows[sourceIndex + 1].offset <= row.offset
        )
          sourceIndex++;
        const source = old?.rows[sourceIndex];
        times[row.index] = source?.time ?? Date.now();
      }
    }
    this.setLineTimes(times);
    this.resetOutputTracking();
    this.resetTrimMarker();
    this.invalidateGutter();
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
