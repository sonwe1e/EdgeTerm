import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { CommandSuggestion } from "./history";
import { FIT_BUFFER_THRESHOLD, FIT_SETTLE_MS, InputAnchor } from "./terminalShared";

interface Context {
  readonly disposed: boolean;
  readonly visible: boolean;
  readonly host: HTMLElement | null;
  readonly fitAddon: FitAddon;
  readonly term: Terminal;
  readonly cellHeight: number;
  readonly measureCell: () => void;
  readonly invalidateGutter: () => void;
  readonly syncGutter: () => void;
  readonly inputAnchor: InputAnchor | null;
  readonly candidates: CommandSuggestion[];
  readonly schedulePopupSync: () => void;
}

export class TerminalViewport {
  /** Only large-buffer column changes wait for the width to settle. */
  private fitTimer: number | null = null;

  /** A post-resize re-measure awaiting xterm's settled screen; see scheduleCellMeasure. */
  private pendingCellMeasure: number | null = null;

  /** One deferred proposal for a renderer that has not measured yet; see fit. */
  private pendingProposeRetry: number | null = null;

  private displayFrame: number | null = null;
  private displayDirty = false;
  private applyDisplayChange: (() => void) | null = null;
  private restoreDisplayChange: (() => void) | null = null;

  /**
   * xterm 6.0.0's RenderService pauses ordinary hidden resizes, but its DPR
   * entry bypasses that pause and rebuilds cached GPU surfaces. Keep the
   * existing xterm measurement/renderer path, defer hidden changes, and fit
   * after visible display metrics settle even if CSS host size did not move.
   * Installed after open(), when RenderService exists; restored on disposal.
   */
  observeDisplayChanges() {
    if (this.restoreDisplayChange) return;
    const service = (
      this.context.term as unknown as {
        _core?: { _renderService?: { handleDevicePixelRatioChange(): void } };
      }
    )._core?._renderService;
    if (!service) return;
    const original = service.handleDevicePixelRatioChange;
    this.applyDisplayChange = () => original.call(service);
    const changed = () => {
      if (this.context.disposed) return;
      this.displayDirty = true;
      if (!this.context.visible || this.displayFrame !== null) return;
      this.displayFrame = window.requestAnimationFrame(() => {
        this.displayFrame = null;
        if (this.context.disposed || !this.context.visible) return;
        this.flushDisplayChange();
        this.fit(true);
      });
    };
    service.handleDevicePixelRatioChange = changed;
    this.restoreDisplayChange = () => {
      if (service.handleDevicePixelRatioChange === changed) {
        service.handleDevicePixelRatioChange = original;
      }
    };
  }

  /** A hidden tab uses the latest scale before its show-time font/fit work. */
  flushDisplayChange() {
    if (!this.displayDirty || this.context.disposed || !this.context.visible) return;
    if (this.displayFrame !== null) window.cancelAnimationFrame(this.displayFrame);
    this.displayFrame = null;
    this.displayDirty = false;
    this.applyDisplayChange?.();
  }

  suspend() {
    this.cancelFit();
    if (this.displayFrame !== null) window.cancelAnimationFrame(this.displayFrame);
    this.displayFrame = null;
  }

  fit(immediate = false): { cols: number; rows: number } | null {
    if (
      this.context.disposed ||
      !this.context.visible ||
      !this.context.host ||
      this.context.host.clientWidth === 0
    )
      return null;
    const proposal = this.tryPropose();
    if (!proposal) {
      // A pane mounted while hidden opened xterm before any pixel existed,
      // and the renderer measures on its first post-visibility render. One
      // retry at that boundary keeps the show-fits contract; giving up here
      // left the terminal at its open-time size (observed as 80x24 with a
      // screen taller than the host).
      this.scheduleProposeRetry(immediate);
      return null;
    }
    return this.applyProposal(proposal, immediate);
  }

  private tryPropose(): { cols: number; rows: number } | null {
    try {
      const proposal = this.context.fitAddon.proposeDimensions() ?? null;
      if (proposal && Number.isFinite(proposal.cols) && Number.isFinite(proposal.rows)) {
        return { cols: proposal.cols, rows: proposal.rows };
      }
    } catch {
      // The renderer has nothing measured yet; the retry handles it.
    }
    return null;
  }

  private applyProposal(
    proposal: { cols: number; rows: number },
    immediate: boolean,
  ): { cols: number; rows: number } | null {
    this.cancelFit();
    if (
      !immediate &&
      proposal.cols === this.context.term.cols &&
      proposal.rows === this.context.term.rows
    ) {
      return { cols: this.context.term.cols, rows: this.context.term.rows };
    }
    if (
      immediate ||
      this.context.term.buffer.normal.length < FIT_BUFFER_THRESHOLD ||
      proposal.cols === this.context.term.cols
    ) {
      return this.applyFit();
    }
    // A diagonal drag must update rows immediately, preserving the current
    // columns until the expensive reflow is due.
    if (proposal.rows !== this.context.term.rows) {
      this.context.term.resize(this.context.term.cols, proposal.rows);
      this.syncFitMetrics();
    }
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = null;
      this.applyFit();
    }, FIT_SETTLE_MS);
    return { cols: this.context.term.cols, rows: this.context.term.rows };
  }

  private scheduleProposeRetry(immediate: boolean): void {
    if (this.context.disposed || !this.context.visible || this.pendingProposeRetry !== null) return;
    this.pendingProposeRetry = window.requestAnimationFrame(() => {
      this.pendingProposeRetry = null;
      if (
        this.context.disposed ||
        !this.context.visible ||
        !this.context.host ||
        this.context.host.clientWidth === 0
      )
        return;
      const proposal = this.tryPropose();
      if (proposal) this.applyProposal(proposal, immediate);
    });
  }

  /**
   * One layout read per resize, at its completion boundary: xterm lays the
   * resized screen out on the animation frame after onResize, and reading
   * earlier divides the old screen height by the new row count. That stale
   * ratio poisoned the gutter pitch until something else refitted (a
   * hidden-resize-show measured 400px/26 rows = 15.34px against 21px text
   * and stayed wrong). Never runs per output render.
   */
  scheduleCellMeasure(): void {
    if (this.context.disposed || this.pendingCellMeasure !== null) return;
    this.pendingCellMeasure = window.requestAnimationFrame(() => {
      this.pendingCellMeasure = null;
      if (this.context.disposed) return;
      const previous = this.context.cellHeight;
      this.context.measureCell();
      if (this.context.cellHeight !== previous) {
        this.context.invalidateGutter();
        this.context.syncGutter();
      }
    });
  }

  cancelFit() {
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    this.fitTimer = null;
  }

  dispose() {
    this.suspend();
    this.restoreDisplayChange?.();
    this.restoreDisplayChange = null;
    this.applyDisplayChange = null;
    this.displayDirty = false;
    if (this.pendingCellMeasure !== null) window.cancelAnimationFrame(this.pendingCellMeasure);
    this.pendingCellMeasure = null;
    if (this.pendingProposeRetry !== null) window.cancelAnimationFrame(this.pendingProposeRetry);
    this.pendingProposeRetry = null;
  }

  private applyFit(): { cols: number; rows: number } | null {
    if (
      this.context.disposed ||
      !this.context.visible ||
      !this.context.host ||
      this.context.host.clientWidth === 0
    )
      return null;
    try {
      this.context.fitAddon.fit();
    } catch {
      return null;
    }
    this.syncFitMetrics();
    return { cols: this.context.term.cols, rows: this.context.term.rows };
  }

  private syncFitMetrics() {
    this.context.measureCell();
    this.context.syncGutter();
    this.scheduleCellMeasure();
    if (this.context.inputAnchor || this.context.candidates.length)
      this.context.schedulePopupSync();
  }

  /** ResizeObserver entry point; uses the same settle policy as explicit fits. */
  scheduleFit() {
    // A hidden terminal never fits (the show path refits explicitly), so the
    // entry point itself is a no-op there — the host observer and any other
    // caller share this one guard.
    if (this.context.disposed || !this.context.visible) return;
    this.fit();
  }
  constructor(private readonly context: Context) {}
}
