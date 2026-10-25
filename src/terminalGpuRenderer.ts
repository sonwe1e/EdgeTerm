import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { isWebglEnabled } from "./terminalRegistry";
import {
  WEBGL_MAX_TERMINALS,
  WEBGL_RECOVERY_DELAY_MS,
  WEBGL_RECOVERY_LIMIT,
  WEBGL_RECOVERY_WINDOW_MS,
} from "./terminalShared";

const webglTerminals: TerminalGpuRenderer[] = [];

interface Context {
  readonly disposed: boolean;
  readonly host: HTMLElement | null;
  readonly term: Terminal;
  readonly sessionId: string;
  readonly visible: boolean;
}

export class TerminalGpuRenderer {
  /** The WebGL addon driving the terminal; null on the DOM renderer. */
  private webgl: WebglAddon | null = null;

  private webglWarned = false;

  /** Recoveries used in the current window; see WEBGL_RECOVERY_LIMIT. */
  private webglRecoveries = 0;

  private webglLastLoss = 0;

  private webglTimer: number | null = null;

  private domRenderingGuarded = false;

  /**
   * WebGL is a large win on heavy output but is unavailable in some
   * environments; the DOM renderer remains a working fallback. The fallback
   * should not be permanent, so a lost context is recreated on the recovery
   * budget. Semantic colors live in the buffer cells and render on either.
   */
  loadWebgl() {
    if (!isWebglEnabled() || this.context.disposed || !this.context.host) return;
    if (this.webgl) {
      this.promoteWebgl();
      return;
    }
    try {
      this.guardHiddenDomRenderer();
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => this.handleWebglLoss(webgl));
      this.context.term.loadAddon(webgl);
      this.setWebgl(webgl);
    } catch (error) {
      if (!this.webglWarned) {
        this.webglWarned = true;
        console.warn(
          `terminal ${this.context.sessionId}: WebGL unavailable, using the DOM renderer`,
          error,
        );
      }
      // The GPU process may still be restarting after a loss; retry on
      // that budget. A cold failure means no WebGL at all: no point.
      if (Date.now() - this.webglLastLoss <= WEBGL_RECOVERY_WINDOW_MS) {
        this.scheduleWebglRecovery();
      }
    }
  }

  private guardHiddenDomRenderer() {
    if (this.domRenderingGuarded) return;
    // xterm 6.0.0's WebglAddon.dispose creates a DOM renderer and schedules
    // handleResize even when IntersectionObserver paused the terminal. That
    // resize paints rows directly, bypassing RenderService's pause. A hidden
    // WidthCache measures zero and repeats layout for every cell. Guard the
    // fallback factory (also used after context loss), keeping resize and
    // selection state intact; the normal show/fit refresh paints it later.
    type Renderer = { renderRows(start: number, end: number): void };
    const core = (
      this.context.term as unknown as {
        _core?: { _createRenderer(): Renderer };
      }
    )._core;
    if (!core?._createRenderer) return;
    const createRenderer = core._createRenderer.bind(core);
    core._createRenderer = () => {
      const renderer = createRenderer();
      const renderRows = renderer.renderRows.bind(renderer);
      renderer.renderRows = (start, end) => {
        if (!this.context.disposed && this.context.visible && this.context.host?.clientWidth) {
          renderRows(start, end);
        }
      };
      return renderer;
    };
    this.domRenderingGuarded = true;
  }

  unloadWebgl() {
    const webgl = this.webgl;
    if (!webgl) return;
    // The addon only detaches its canvas; the GPU context behind it (and
    // its window-sized surface) lives on until garbage collection and keeps
    // counting against WebKit's limit meanwhile. Lose it explicitly.
    const canvas = this.webglCanvas();
    webgl.dispose();
    canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    this.setWebgl(null);
  }

  /** Brings this terminal onto the current renderer preference, if it can. */
  refreshWebgl() {
    if (!isWebglEnabled()) this.unloadWebgl();
    else if (this.context.visible) this.loadWebgl();
  }

  dispose() {
    if (this.webglTimer !== null) window.clearTimeout(this.webglTimer);
    this.webglTimer = null;
    this.unloadWebgl();
  }

  /** The addon's canvas: the one in the screen without a render-layer class. */
  private webglCanvas(): HTMLCanvasElement | null {
    const screen = this.context.term.element?.querySelector(".xterm-screen");
    if (!screen) return null;
    for (const canvas of screen.querySelectorAll(":scope > canvas")) {
      if (!canvas.className) return canvas as HTMLCanvasElement;
    }
    return null;
  }

  private handleWebglLoss(webgl: WebglAddon) {
    // The addon reports the loss 3 s after the event; it may have been
    // unloaded in between.
    if (this.webgl !== webgl) return;
    webgl.dispose();
    this.setWebgl(null);
    console.warn(`terminal ${this.context.sessionId}: WebGL context lost`);
    const now = Date.now();
    if (now - this.webglLastLoss > WEBGL_RECOVERY_WINDOW_MS) {
      this.webglRecoveries = 0;
    }
    this.webglLastLoss = now;
    this.scheduleWebglRecovery();
  }

  private scheduleWebglRecovery() {
    // A hidden terminal simply loads WebGL again when it is shown.
    if (this.context.disposed || !this.context.visible || this.webglTimer !== null) return;
    if (this.webglRecoveries >= WEBGL_RECOVERY_LIMIT) {
      console.warn(
        `terminal ${this.context.sessionId}: WebGL did not come back after ` +
          `${WEBGL_RECOVERY_LIMIT} attempts within a minute, staying on the DOM renderer`,
      );
      return;
    }
    this.webglRecoveries += 1;
    this.webglTimer = window.setTimeout(() => {
      this.webglTimer = null;
      this.loadWebgl();
    }, WEBGL_RECOVERY_DELAY_MS);
  }

  /** Records a renderer switch. */
  private setWebgl(webgl: WebglAddon | null) {
    this.webgl = webgl;
    if (webgl) {
      this.promoteWebgl();
    } else {
      const index = webglTerminals.indexOf(this);
      if (index >= 0) webglTerminals.splice(index, 1);
    }
  }

  /** Moves this terminal to the front of the holders, evicting past the limit. */
  private promoteWebgl() {
    const index = webglTerminals.indexOf(this);
    if (index >= 0) webglTerminals.splice(index, 1);
    webglTerminals.unshift(this);
    while (webglTerminals.length > WEBGL_MAX_TERMINALS) {
      webglTerminals.pop()?.unloadWebgl();
    }
  }
  constructor(private readonly context: Context) {}
}
