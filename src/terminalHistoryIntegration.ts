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
  /** Rows were re-inserted at the top; the gutter renumbers by this. */
  onPrepended?: (rows: number) => void;
  /** Diagnostics surface (mismatch detail, dropped-line counts). */
  onNotice?: (text: string) => void;
}

export class TerminalColdHistory {
  private readonly options: ColdHistoryOptions;
  private capture: ReturnType<typeof createHistoryCapture> | null = null;
  private loading = false;
  private exhausted = false;
  private wheelElement: HTMLElement | null = null;

  constructor(options: ColdHistoryOptions) {
    this.options = options;
  }

  /** Called from the controller's onWriteParsed hook. */
  outputParsed(): void {
    if (!this.options.enabled()) return;
    if (!this.capture) {
      this.capture = createHistoryCapture(this.options.terminal, {
        onBatch: (bytes) => {
          void this.sendBatch(bytes);
        },
        onMismatch: (detail) => this.options.onNotice?.(detail),
      });
    }
    this.capture.notifyWriteParsed();
  }

  private async sendBatch(bytes: Uint8Array): Promise<void> {
    try {
      const outcome = await commands.historyAppend(this.options.sessionId, Array.from(bytes));
      if (outcome.droppedLines > 0) {
        this.options.onNotice?.(`cold history dropped ${outcome.droppedLines} oldest lines`);
      }
    } catch (error) {
      this.options.onNotice?.(`cold history append failed: ${String(error)}`);
    }
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
    if (!this.options.enabled() || this.loading || this.exhausted) return;
    if (this.options.terminal.buffer.active.viewportY > 0) return;
    void this.loadOlder();
  };

  private async loadOlder(): Promise<void> {
    this.loading = true;
    try {
      // history_read pages newest-first; the prepend wants oldest-first.
      const records: HistoryRecord[] = await commands.historyRead(
        this.options.sessionId,
        1,
        LOAD_CHUNK_RECORDS,
      );
      if (records.length === 0) {
        this.exhausted = true;
        return;
      }
      const prepended = await prependRecords(this.options.terminal, [...records].reverse());
      if (prepended <= 0) {
        this.exhausted = true;
        return;
      }
      this.capture?.notePrepended(prepended);
      this.options.onPrepended?.(prepended);
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
    this.capture?.noteClear();
    this.exhausted = false;
    void commands.historyClear(this.options.sessionId).catch(() => undefined);
  }

  dispose(): void {
    this.detachWheel();
    this.capture?.dispose();
    this.capture = null;
    void commands.historyClear(this.options.sessionId).catch(() => undefined);
  }
}
