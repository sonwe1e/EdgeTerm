import { page } from "vitest/browser";
import { browserAfterEach, frame, mount, twoFrames, wait } from "./browserHarness";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";

// Real xterm in a real pixel container: the browser project deliberately does
// not load the jsdom stubs, so proposeDimensions/fit measure the page for
// real and the 100 ms column settle runs on real timers. The 200-line
// threshold is exercised at its exact boundary (199/200 lines written
// literally), and the show path below is the production call sequence
// TerminalPane.tsx runs when a tab becomes visible: setVisible(true) first,
// then one requestAnimationFrame later fit(true) — setVisible itself does
// not fit, per the code. One test mounts the real SessionPane so the hide →
// show chain runs through the component, not a re-enactment.
//
// Boundary (scripts/README wording): proves the controller's fit contract
// against a real renderer in Chromium. PTY round-trips of onResize, real
// session output and WebView2 are NOT covered here.
import "../styles.css";
import { SessionPane } from "../components/TerminalPane";
import { getController, setWebglEnabled } from "../terminalRegistry";
import { TerminalController } from "../terminal";
import { IS_MAC, IS_WINDOWS } from "../platform";
import type { Tab } from "../store";

const live: TerminalController[] = [];
let previousWebgl: boolean | null = null;

const make = (pane: HTMLElement): { controller: TerminalController; resizes: { cols: number; rows: number; at: number }[] } => {
  const resizes: { cols: number; rows: number; at: number }[] = [];
  const controller = new TerminalController(
    `fit-browser-${live.length}-${Date.now()}`,
    {
      onData: () => {},
      onResize: (cols, rows) => { resizes.push({ cols, rows, at: performance.now() }); },
      onStatus: () => {},
      onCommand: () => {},
      onCommandState: () => {},
      suggest: () => [],
      forgetSuggestion: () => {},
    },
    14,
    5000,
    "dark",
  );
  controller.attach(pane);
  live.push(controller);
  return { controller, resizes };
};

const write = (controller: TerminalController, text: string): Promise<void> =>
  new Promise((resolve) => controller.term.write(text, resolve));

/** n separate buffer lines (no trailing CRLF, so the count is exact). */
const lines = (n: number): string =>
  Array.from({ length: n }, (_, index) => `line ${index}`).join("\r\n");

const settles = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (performance.now() > deadline) return false;
    await wait(25);
  }
};

/**
 * The fit relation, read off the real page: the xterm screen must fit inside
 * its host and be maximal at the cell grid (one more row/column would not
 * fit). Every allowance is measured from the page itself. In particular the
 * column allowance is the terminal's OWN custom vertical scrollbar (xterm 6
 * sizes it itself; the OS overlay scrollbar of a generic probe measures 0
 * and is a different mechanism), read from its live DOM element.
 */
const pixelContract = (controller: TerminalController): { ok: boolean; detail: string } => {
  const element = controller.term.element!;
  const host = element.parentElement!;
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!;
  const vScrollbar = element.querySelector<HTMLElement>(".scrollbar.vertical");
  const screenW = parseFloat(screen.style.width);
  const screenH = parseFloat(screen.style.height);
  const cols = controller.term.cols;
  const rows = controller.term.rows;
  const cellW = screenW / cols;
  const cellH = screenH / rows;
  const reserved = vScrollbar ? vScrollbar.offsetWidth : 0;
  const availableW = host.clientWidth - reserved;
  const availableH = host.clientHeight;
  const ok = screenW <= availableW + 1 && screenW + 2 * cellW > availableW + 1 &&
    screenH <= availableH + 1 && screenH + 2 * cellH > availableH + 1;
  return {
    ok,
    detail: `cols=${cols} rows=${rows} screen=${screenW}x${screenH} ` +
      `host=${host.clientWidth}x${host.clientHeight} reserved=${reserved} ` +
      `vbar=${vScrollbar ? "found" : "missing"}`,
  };
};

const mountPane = (width: number, height: number): HTMLElement => {
  const pane = createElement("div", {
    className: "term-pane",
    "data-pane": "",
    style: { left: "0px", top: "0px", width: `${width}px`, height: `${height}px` },
  });
  mount(pane);
  return document.querySelector<HTMLElement>("[data-pane]")!;
};

const resizePane = (pane: HTMLElement, width: number, height: number): void => {
  pane.style.width = `${width}px`;
  pane.style.height = `${height}px`;
};

const sessionTab = (id: string): Tab => ({
  info: {
    id,
    profileId: null,
    name: id,
    kind: "local",
    protocol: "local",
    address: "",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: `profile-${id}`, name: id, kind: "local" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: "browser-pane",
});

describe("TerminalController fit in a real container", () => {
  beforeAll(async () => {
    await page.viewport(1280, 860);
    await document.fonts.ready;
  });

  afterEach(async () => {
    // Every failure still surfaces, every resource still gets its attempt.
    const errors: unknown[] = [];
    while (live.length) {
      const controller = live.pop()!;
      try {
        controller.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await browserAfterEach();
    } catch (error) {
      errors.push(error);
    }
    // The gutter geometry oracle needs the DOM renderer's real row
    // rectangles; the preference goes back whatever the previous test left.
    if (previousWebgl !== null) {
      setWebglEnabled(previousWebgl);
      previousWebgl = null;
    }
    if (errors.length > 0) {
      throw new Error(`terminal fit cleanup failed:\n${errors.map(String).join("\n")}`);
    }
  });

  it("the platform defines resolve against the real build host (control)", () => {
    // The repository builds on three operating systems, so the oracle is the
    // host vitest actually runs on (injected by the test config from the
    // same process.platform the production defines use), not a hardcoded
    // OS literal. When the defines are missing entirely, production modules
    // fail to import at all — the failure mode this control guards.
    const host = (globalThis as { __EDGETERM_TEST_HOST__?: string }).__EDGETERM_TEST_HOST__;
    expect(host, "the test-config define reached the page").toBeTypeOf("string");
    expect(IS_MAC).toBe(host === "darwin");
    expect(IS_WINDOWS).toBe(host === "win32");
  });

  it("a hidden terminal does not fit: attach records no resize", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    await twoFrames();

    expect(controller.fit()).toBeNull();
    expect(resizes.length, "no onResize while hidden").toBe(0);
    // xterm's own defaults, written literally: no fit has been applied.
    expect(controller.term.cols).toBe(80);
    expect(controller.term.rows).toBe(24);
  });

  it("the show path fills the real pixel container once fonts are ready", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    // TerminalPane's show effect: one frame later, an explicit immediate fit.
    await frame();
    const fitted = controller.fit(true);
    expect(fitted).not.toBeNull();
    expect(resizes.length).toBeGreaterThanOrEqual(1);
    expect(resizes[resizes.length - 1].cols).toBe(controller.term.cols);
    expect(resizes[resizes.length - 1].rows).toBe(controller.term.rows);
    const pixels = pixelContract(controller);
    expect(pixels.ok, pixels.detail).toBe(true);
    expect(controller.term.cols).toBeGreaterThan(40);
    expect(controller.term.rows).toBeGreaterThan(10);
  });

  it("buffers under 200 lines resize both axes immediately", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    await frame();
    controller.fit(true);

    await write(controller, lines(199));
    expect(controller.term.buffer.normal.length,
      "the 199-line input really sits in the normal buffer").toBe(199);

    resizePane(pane, 780, 480);
    controller.scheduleFit();
    await twoFrames();
    expect(controller.term.cols).toBeGreaterThan(80);
    expect(controller.term.rows).toBeGreaterThan(20);
    expect(resizes[resizes.length - 1].cols).toBe(controller.term.cols);
    expect(resizes[resizes.length - 1].rows).toBe(controller.term.rows);
    const pixels = pixelContract(controller);
    expect(pixels.ok, pixels.detail).toBe(true);
  });

  it("at the 200-line threshold rows move now and columns wait for the last width event", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    await frame();
    controller.fit(true);

    await write(controller, lines(200));
    expect(controller.term.buffer.normal.length,
      "the threshold line count is exact").toBe(200);

    // Column-only, large buffer: the scheduleFit call returns with columns
    // still unchanged — that is synchronous truth, not a race against the
    // 100 ms settle — and then the columns arrive.
    const colsBefore = controller.term.cols;
    resizePane(pane, 900, 400);
    controller.scheduleFit();
    expect(controller.term.cols,
      "columns are still pending the moment scheduleFit returns").toBe(colsBefore);
    expect(await settles(() => controller.term.cols !== colsBefore),
      "pending columns apply after the settle").toBe(true);
    const colsAt900 = controller.term.cols;
    expect(colsAt900).toBeGreaterThan(colsBefore);

    // Row-only, large buffer: rows are immediate (no reflow is owed).
    const rowsAt400 = controller.term.rows;
    resizePane(pane, 900, 560);
    controller.scheduleFit();
    expect(controller.term.rows,
      "rows move at once even for a large buffer").toBeGreaterThan(rowsAt400);
    expect(resizes[resizes.length - 1].rows).toBe(controller.term.rows);

    // Diagonal, large buffer: the rows phase lands synchronously with the
    // scheduleFit call — at the new 640px height — while the columns phase
    // keeps the previous geometry until its settle passes.
    const rowsAt560 = controller.term.rows;
    resizePane(pane, 1060, 640);
    controller.scheduleFit();
    expect(controller.term.rows,
      "diagonal rows applied at once for the new height").toBeGreaterThan(rowsAt560);
    expect(controller.term.cols,
      "diagonal keeps the old columns in the rows phase").toBe(colsAt900);
    const rowsAt640 = controller.term.rows;
    expect(await settles(() => controller.term.cols !== colsAt900),
      "diagonal columns apply after the settle").toBe(true);
    expect(controller.term.rows,
      "the rows phase result is final; the settle only moves columns").toBe(rowsAt640);
    const pixels = pixelContract(controller);
    expect(pixels.ok, pixels.detail).toBe(true);
    const colsAt1060 = controller.term.cols;

    // The LAST width event wins: 1140 is scheduled, then 1060 supersedes it
    // inside the settle window. The final columns must equal the value this
    // test already observed for the same 1060 geometry in the diagonal step
    // — and must stay there after the first task's window has fully passed.
    resizePane(pane, 1140, 640);
    controller.scheduleFit();
    await wait(30);
    resizePane(pane, 1060, 640);
    controller.scheduleFit();
    expect(await settles(() => controller.term.cols === colsAt1060),
      "the later width event replaced the pending one").toBe(true);
    await wait(250);
    expect(controller.term.cols,
      "no late change from the superseded 1140 task").toBe(colsAt1060);
  });

  it("hiding cancels the pending column task and the terminal stops fitting", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    await frame();
    controller.fit(true);
    await write(controller, lines(210));

    // Leave a column change pending (large buffer, new width); hiding is
    // exactly what the pane does on a tab switch.
    const colsBefore = controller.term.cols;
    resizePane(pane, 900, 400);
    controller.scheduleFit();
    controller.setVisible(false);

    await wait(250);
    expect(controller.term.cols,
      "the pending column fit was cancelled by hide").toBe(colsBefore);
    expect(controller.fit(), "fit refuses while hidden").toBeNull();
    const resizesAtHide = resizes.length;

    // A resize reported while hidden must not fit either.
    resizePane(pane, 1000, 460);
    controller.scheduleFit();
    await twoFrames();
    expect(controller.term.cols).toBe(colsBefore);
    expect(resizes.length).toBe(resizesAtHide);
  });

  it("showing remeasures immediately through the pane's show path", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    await frame();
    controller.fit(true);
    await write(controller, lines(300));

    // While hidden the pane is laid out at a new size; nothing fits yet.
    const rowsAtHide = controller.term.rows;
    resizePane(pane, 1000, 600);
    controller.setVisible(false);
    await twoFrames();
    expect(controller.fit()).toBeNull();

    // The pane's show path: setVisible(true), one frame, explicit fit —
    // immediate even for a large buffer (fit(true) skips the settle).
    controller.setVisible(true);
    await frame();
    const fitted = controller.fit(true);
    expect(fitted).not.toBeNull();
    expect(resizes[resizes.length - 1].cols).toBe(controller.term.cols);
    expect(resizes[resizes.length - 1].rows).toBe(controller.term.rows);
    const pixels = pixelContract(controller);
    expect(pixels.ok, pixels.detail).toBe(true);
    expect(controller.term.rows,
      "the 600px-tall pane fits more rows than the 400px one did").toBeGreaterThan(rowsAtHide);
  });

  it("the real SessionPane hides without fitting and refits on show", async () => {
    const id = "fit-pane-browser";
    // The gutter geometry oracle reads the DOM renderer's real row
    // rectangles: select it through the public renderer preference and put
    // the previous preference back afterwards. This is a public setting, not
    // a mock of fit or layout.
    previousWebgl = true;
    setWebglEnabled(false);
    const paneProps = (visible: boolean, width: number, height: number) =>
      createElement(SessionPane, {
        tab: sessionTab(id),
        visible,
        focused: false,
        style: { left: "0px", top: "0px", width: `${width}px`, height: `${height}px` },
      });
    // The real component with a real registry controller — only the IPC
    // behind its callbacks is unreachable in a plain browser, where those
    // promises reject and are swallowed by the production catch handlers.
    const session = mount(paneProps(false, 640, 400));
    expect(await settles(() => getController(id) !== undefined, 3000),
      "the pane's ensureController wiring registered the terminal").toBe(true);
    const controller = getController(id)!;
    live.push(controller);
    await twoFrames();
    expect(controller.term.cols, "hidden pane never fit (still 80)").toBe(80);

    // Showing runs the component's own effect chain: setVisible(true), then
    // a frame later fit(true).
    session.render(paneProps(true, 640, 400));
    expect(await settles(() => controller.term.cols !== 80, 3000),
      "the visible pane fit through its own effect").toBe(true);
    const pixels = pixelContract(controller);
    expect(pixels.ok, pixels.detail).toBe(true);

    // Real output sits in the buffer, so the shown large-buffer contract and
    // the gutter rows are exercised over actual content, not an empty pane.
    await write(controller, lines(300));
    expect(controller.term.buffer.normal.length,
      "the written session output is really in the normal buffer").toBe(300);
    await wait(100);

    // Hidden at a new geometry: no fit. Shown again: the new geometry is
    // measured immediately (the show fit is explicit).
    const colsShown = controller.term.cols;
    session.render(paneProps(false, 900, 560));
    await twoFrames();
    expect(controller.term.cols, "the hidden pane keeps its old fit").toBe(colsShown);
    session.render(paneProps(true, 900, 560));
    expect(await settles(() => controller.term.cols !== colsShown, 3000),
      "the resized pane refits on show").toBe(true);
    expect(controller.term.cols).toBeGreaterThan(colsShown);

    // The gutter rides the same chain: its rows size themselves from the
    // measured terminal cell height (--gutter-cell). A stale measurement
    // from an earlier geometry must not survive the show: sampled two real
    // frames after the show — before any later resize task can run — the
    // gutter pitch and the DOM text row pitch must already agree, and stay
    // agreed once settled, with no extra fit call to mask a stale value.
    const gutterAlignment = (): { gutterPitch: number; textPitch: number; maxRowOffset: number; rows: number } => {
      const gutters = Array.from(document.querySelectorAll<HTMLElement>(".gutter-row"));
      const texts = Array.from(document.querySelectorAll<HTMLElement>(".xterm-rows > div"));
      const gutterPitch = gutters.length > 1
        ? gutters[1].getBoundingClientRect().top - gutters[0].getBoundingClientRect().top
        : Number.NaN;
      const textPitch = texts.length > 1
        ? texts[1].getBoundingClientRect().top - texts[0].getBoundingClientRect().top
        : Number.NaN;
      const count = Math.min(gutters.length, texts.length);
      let maxRowOffset = 0;
      for (let index = 0; index < count; index += 1) {
        maxRowOffset = Math.max(maxRowOffset, Math.abs(
          gutters[index].getBoundingClientRect().top - texts[index].getBoundingClientRect().top,
        ));
      }
      return { gutterPitch, textPitch, maxRowOffset, rows: count };
    };
    const expectAligned = (when: string) => {
      const sample = gutterAlignment();
      expect(sample.rows, `${when}: gutter and text rows rendered (${sample.rows})`).toBeGreaterThan(1);
      expect(Number.isFinite(sample.gutterPitch) && Number.isFinite(sample.textPitch),
        `${when}: pitches measurable`).toBe(true);
      expect(Math.abs(sample.gutterPitch - sample.textPitch),
        `${when}: gutter pitch ${sample.gutterPitch} must equal text pitch ${sample.textPitch}`)
        .toBeLessThan(0.1);
      expect(sample.maxRowOffset, `${when}: max gutter/text row offset ${sample.maxRowOffset}`)
        .toBeLessThan(0.5);
    };
    await twoFrames();
    expectAligned("two frames after the resized show");
    await wait(250);
    expectAligned("settled after the resized show");
    await twoFrames();
    expectAligned("two frames after the settled state (no late drift)");
  });

  it("dispose leaves no late resize", async () => {
    const pane = mountPane(640, 400);
    const { controller, resizes } = make(pane);
    controller.setVisible(true);
    await frame();
    controller.fit(true);
    await write(controller, lines(220));

    // Pending column fit, then dispose before it can run.
    resizePane(pane, 900, 400);
    controller.scheduleFit();
    const resizesAtDispose = resizes.length;
    const disposedAt = performance.now();
    controller.dispose();

    await wait(250);
    expect(resizes.length, "no onResize after dispose").toBe(resizesAtDispose);
    for (const entry of resizes) {
      expect(entry.at, "no resize timestamped after dispose").toBeLessThanOrEqual(disposedAt);
    }
    expect(controller.fit(), "a disposed terminal never fits again").toBeNull();
    expect(() => controller.scheduleFit()).not.toThrow();
  });
});
