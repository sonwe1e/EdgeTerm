import type { Terminal } from "@xterm/xterm";
import { commands } from "./bindings";
import { createHistoryCapture } from "./terminalHistoryCapture";
import type { HistoryRecord } from "./terminalHistory";
import { prependRecords } from "./terminalHistoryMaterialize";

/**
 * The A2 glue between one terminal and the Rust cold store (D14): trimmed
 * lines leave through the capture's batches, and scrolling past the buffer
 * top re-inserts them through the prepend primitive so the hot window and
 * the cold blocks form one seamless buffer. Everything is inert while the
 * preference is off; the capture starts lazily on the first write after the
 * switch turns on, and a cleared or closed session releases its store.
 */
const LOAD_CHUNK_RECORDS = 500;

export interface ColdHistoryOptions {
  terminal: Terminal;
  sessionId: string;
  /** Read per write; the settings dialog flips it at runtime. */
  enabled: () => boolean;
  /** Time for a physical buffer row at capture time (not its logical history ID). */
  lineTimeAtRow?: (row: number) => number | null;
  /** An interactive program in the normal buffer still owns its mouse/scrolling. */
  interactiveProgramActive?: () => boolean;
  /** Rows were re-inserted at the top, in the same oldest-first record order. */
  onPrepended?: (rows: number, records: readonly HistoryRecord[]) => void;
  /** Diagnostics surface (mismatch detail, dropped-line counts). */
  onNotice?: (text: string) => void;
}

export class TerminalColdHistory {
  private readonly options: ColdHistoryOptions;
  private capture: ReturnType<typeof createHistoryCapture> | null = null;
  private loading = false;
  private exhausted = false;
  private disposed = false;
  private epoch = 0;
  /** IPC calls must preserve capture order, including a clear after an append. */
  private pendingWrites: Promise<void> = Promise.resolve();
  private wheelElement: HTMLElement | null = null;

  constructor(options: ColdHistoryOptions) {
    this.options = options;
  }

  /** Called from the controller's onWriteParsed hook. */
  outputParsed(): void {
    if (this.disposed || !this.options.enabled()) return;
    if (!this.capture) {
      this.capture = createHistoryCapture(this.options.terminal, {
        lineTimeAtRow: this.options.lineTimeAtRow,
        onBatch: (bytes) => this.queueBatch(bytes),
        onMismatch: (detail) => this.options.onNotice?.(detail),
      });
    }
    this.capture.notifyWriteParsed();
  }

  private queueBatch(bytes: Uint8Array): void {
    const epoch = this.epoch;
    this.pendingWrites = this.pendingWrites.then(async () => {
      if (this.disposed || epoch !== this.epoch) return;
      try {
        const outcome = await commands.historyAppend(this.options.sessionId, Array.from(bytes));
        if (epoch !== this.epoch || this.disposed) return;
        // A previously exhausted read can become useful after further output
        // trims the hot buffer. Do not permanently freeze the scroll top.
        this.exhausted = false;
        if (outcome.droppedLines > 0) {
          this.options.onNotice?.(`cold history dropped ${outcome.droppedLines} oldest lines`);
        }
      } catch (error) {
        if (epoch === this.epoch && !this.disposed) {
          this.options.onNotice?.(`cold history append failed: ${String(error)}`);
        }
      }
    });
  }

  private queueClear(): void {
    // Older batches may already be in flight. Their completion must happen
    // before the clear, and all new batches must happen after it.
    this.pendingWrites = this.pendingWrites.then(() =>
      commands.historyClear(this.options.sessionId).then(() => undefined),
    );
    this.pendingWrites = this.pendingWrites.catch((error) => {
      if (!this.disposed) this.options.onNotice?.(`cold history clear failed: ${String(error)}`);
    });
  }

  private canLoad(): boolean {
    const term = this.options.terminal;
    return (
      !this.disposed &&
      this.options.enabled() &&
      !this.options.interactiveProgramActive?.() &&
      term.buffer.active.type === "normal" &&
      term.buffer.active.viewportY === 0
    );
  }

  /** Upper-exclusive logical ID of cold-only records for the Find box. */
  coldSearchBeforeAbs(): number | null {
    const term = this.options.terminal;
    if (
      this.disposed ||
      !this.options.enabled() ||
      this.options.interactiveProgramActive?.() ||
      term.buffer.active.type !== "normal"
    ) {
      return null;
    }
    return this.capture?.oldestBufferedExportedAbsLine() ?? null;
  }

  /** Binds after term.open: wheels past the top pull one cold chunk in. */
  attachWheel(element: HTMLElement | null): void {
    this.detachWheel();
    this.wheelElement = element;
    element?.addEventListener("wheel", this.onWheel, { capture: true, passive: true });
  }

  private detachWheel(): void {
    this.wheelElement?.removeEventListener("wheel", this.onWheel, { capture: true });
    this.wheelElement = null;
  }

  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY >= 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.loading || this.exhausted || !this.capture || !this.canLoad()) return;
    void this.loadOlder();
  };

  private async loadOlder(): Promise<void> {
    this.loading = true;
    const epoch = this.epoch;
    try {
      // The exporter runs *before* xterm trims, so its newest records can
      // still be present in the hot buffer. Only read older than the oldest
      // exported logical line still visible there, never from absolute 1.
      if ((this.capture?.oldestBufferedExportedAbsLine() ?? 0) <= 1) return;
      await this.pendingWrites;
      if (epoch !== this.epoch || !this.canLoad()) return;
      const beforeAbs = this.capture?.oldestBufferedExportedAbsLine();
      if (beforeAbs === null || beforeAbs === undefined || beforeAbs <= 1) return;
      // Rust returns newest-first records with absLine < beforeAbs. The
      // current buffer front is the cursor: each prepend extends it backwards.
      const records: HistoryRecord[] = await commands.historyReadBefore(
        this.options.sessionId,
        beforeAbs,
        LOAD_CHUNK_RECORDS,
      );
      if (
        epoch !== this.epoch ||
        !this.canLoad() ||
        this.capture?.oldestBufferedExportedAbsLine() !== beforeAbs
      ) {
        return;
      }
      if (records.length === 0) {
        this.exhausted = true;
        return;
      }
      // Any unexpected store/page ordering must not corrupt the live buffer.
      if (
        records.some(
          (record, index) =>
            record.absLine >= beforeAbs ||
            (index > 0 && record.absLine >= records[index - 1].absLine),
        )
      ) {
        throw new Error("history read returned an invalid or overlapping page");
      }
      const oldestFirst = [...records].reverse();
      // Materialization yields to a scratch parser. A concurrent SSH write
      // can trim another hot line while it is suspended, moving the seam.
      // Recheck the *exact* cursor before splice to avoid inserting a page
      // at a stale position and silently losing a portion of the transcript.
      const prepended = await prependRecords(
        this.options.terminal,
        oldestFirst,
        () =>
          epoch === this.epoch &&
          this.canLoad() &&
          this.capture?.oldestBufferedExportedAbsLine() === beforeAbs,
      );
      if (prepended <= 0) {
        // A resize or Agent buffer switch may have canceled the commit.
        // The next wheel may retry; it is not evidence of exhausted history.
        return;
      }
      this.capture?.notePrepended(prepended);
      this.options.onPrepended?.(prepended, oldestFirst);
      if (records.length < LOAD_CHUNK_RECORDS) this.exhausted = true;
      // Stay on the top row: the cold block just became the buffer top.
      this.options.terminal.scrollToTop();
    } catch (error) {
      this.options.onNotice?.(`cold history load failed: ${String(error)}`);
    } finally {
      this.loading = false;
    }
  }

  /** ED 3 / "clear buffer": the line numbering and the store both reset. */
  cleared(): void {
    this.epoch++;
    this.capture?.noteClear();
    this.exhausted = false;
    this.queueClear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.epoch++;
    this.disposed = true;
    this.detachWheel();
    this.capture?.dispose();
    this.capture = null;
    this.queueClear();
  }
}
