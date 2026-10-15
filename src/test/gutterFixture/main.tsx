import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import "../../styles.css";
import { SessionPane } from "../../components/TerminalPane";
import { ensureController } from "../../actions";
import { disposeController, getController, setWebglEnabled } from "../../terminalRegistry";
import { useStore, type Tab } from "../../store";

/**
 * Fixture for scripts/check-gutter-alignment.mjs: a production build of the
 * real SessionPane / TerminalController driven through the same public calls
 * the app makes — the production ensureController factory registers the
 * session, the component borrows it, output is written through the public
 * write path, fonts change through the store. The DOM renderer is selected
 * through the public renderer preference — the gutter geometry oracle reads
 * its real row rectangles. No layout or fit call is mocked; the IPC boundary
 * is a strict whitelist that also records violations (production swallows
 * the rejections, so the record — not the throw — is the gate).
 */

setWebglEnabled(false);

const tabFor = (id: string): Tab => ({
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
  paneId: "gutter-check-pane",
});

let root: Root | null = null;
let sessionId = "";
let directHost: HTMLElement | null = null;
const createdIds = new Set<string>();

const sessionProps = (visible: boolean, width: number, height: number) =>
  createElement(SessionPane, {
    tab: tabFor(sessionId),
    visible,
    focused: false,
    style: { left: "0px", top: "0px", width: `${width}px`, height: `${height}px` },
  });

const write = (id: string, text: string): Promise<void> => {
  const controller = getController(id);
  if (!controller) throw new Error(`no controller for ${id}`);
  return new Promise((resolve) => controller.term.write(text, resolve));
};

const lines = (n: number): string =>
  Array.from({ length: n }, (_, index) => `line ${index}`).join("\r\n");

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const session = (): NonNullable<ReturnType<typeof getController>> => {
  const controller = getController(sessionId);
  if (!controller) throw new Error(`no controller for ${sessionId}`);
  return controller;
};

declare global {
  interface Window {
    __gutterCheck: {
      createDirect(width: number, height: number, outputLines: number): Promise<{ id: string; cols: number; rows: number }>;
      sessionCreate(): Promise<string>;
      sessionMount(visible: boolean, width: number, height: number): void;
      writeLines(count: number): Promise<number>;
      setFont(size: number): void;
      scheduleFit(): void;
      resizePane(width: number, height: number): void;
      sample(): {
        bufferLength: number;
        gutterRows: number;
        textRows: number;
        gutterPitch: number | null;
        textPitch: number | null;
        maxRowOffset: number | null;
        rows: number | null;
        cols: number | null;
        screenHeight: number | null;
        screenWidth: number | null;
        hostHeight: number | null;
        hostWidth: number | null;
        reservedScrollbar: number;
        gutterCell: string | null;
      };
      disposeAll(): void;
    };
    __gutterCheckReady: boolean;
    __gutterCheckUnexpectedIpc: string[];
  }
}

window.__gutterCheckUnexpectedIpc = [];

window.__gutterCheck = {
  /** A real factory session shown directly (no component). */
  async createDirect(width: number, height: number, outputLines: number) {
    const id = `gutter-direct-${Date.now()}`;
    createdIds.add(id);
    directHost = document.createElement("div");
    directHost.className = "term-pane";
    directHost.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`;
    document.body.append(directHost);
    const controller = await ensureController(id);
    controller.attach(directHost);
    controller.setVisible(true);
    await frame();
    controller.fit(true);
    if (outputLines > 0) await write(id, lines(outputLines));
    sessionId = id;
    return { id, cols: controller.term.cols, rows: controller.term.rows };
  },
  /** The production factory registers the session BEFORE any component. */
  async sessionCreate(): Promise<string> {
    sessionId = `gutter-session-${Date.now()}`;
    createdIds.add(sessionId);
    await ensureController(sessionId);
    return sessionId;
  },
  /** Mounts or updates the real SessionPane (the component chain). */
  sessionMount(visible: boolean, width: number, height: number): void {
    const mountPoint = document.getElementById("gutter-check-mount")!;
    root ??= createRoot(mountPoint);
    flushSync(() => root!.render(sessionProps(visible, width, height)));
  },
  async writeLines(count: number): Promise<number> {
    await write(sessionId, lines(count));
    return session().term.buffer.normal.length;
  },
  setFont(size: number): void {
    flushSync(() => useStore.getState().setBufferFontSize(size));
  },
  /** The real ResizeObserver entry point on the live session. */
  scheduleFit(): void {
    session().scheduleFit();
  },
  resizePane(width: number, height: number): void {
    const pane = (document.querySelector<HTMLElement>(".pane-slot")
      ?? directHost)!;
    if (!pane) throw new Error("no pane to resize");
    pane.style.width = `${width}px`;
    pane.style.height = `${height}px`;
  },
  sample() {
    const gutters = Array.from(document.querySelectorAll<HTMLElement>(".gutter-row"));
    const texts = Array.from(document.querySelectorAll<HTMLElement>(".xterm-rows > div"));
    const screen = document.querySelector<HTMLElement>(".xterm-screen");
    const gutter = document.querySelector<HTMLElement>(".term-gutter");
    // The terminal's own custom vertical scrollbar reservation, read off the
    // live DOM (the OS overlay scrollbar measures 0 and is a different
    // mechanism).
    const vScrollbar = document.querySelector<HTMLElement>(".scrollbar.vertical");
    const offsets: number[] = [];
    const count = Math.min(gutters.length, texts.length);
    for (let index = 0; index < count; index += 1) {
      offsets.push(Math.abs(
        gutters[index].getBoundingClientRect().top - texts[index].getBoundingClientRect().top,
      ));
    }
    const controller = getController(sessionId);
    // The element fit actually measures: xterm's own parent (.term-host),
    // not the pane — the gutter takes its width out of the columns.
    const fitHost = controller?.term.element?.parentElement ?? null;
    return {
      bufferLength: controller?.term.buffer.normal.length ?? 0,
      gutterRows: gutters.length,
      textRows: texts.length,
      gutterPitch: gutters.length > 1
        ? gutters[1].getBoundingClientRect().top - gutters[0].getBoundingClientRect().top
        : null,
      textPitch: texts.length > 1
        ? texts[1].getBoundingClientRect().top - texts[0].getBoundingClientRect().top
        : null,
      maxRowOffset: offsets.length ? Math.max(...offsets) : null,
      rows: controller?.term.rows ?? null,
      cols: controller?.term.cols ?? null,
      screenHeight: screen?.clientHeight ?? null,
      screenWidth: screen ? parseFloat(screen.style.width) : null,
      hostHeight: fitHost?.clientHeight ?? null,
      hostWidth: fitHost?.clientWidth ?? null,
      reservedScrollbar: vScrollbar ? vScrollbar.offsetWidth : 0,
      gutterCell: gutter ? getComputedStyle(gutter).getPropertyValue("--gutter-cell") : null,
    };
  },
  disposeAll(): void {
    for (const id of createdIds) disposeController(id);
    createdIds.clear();
    sessionId = "";
    root?.unmount();
    root = null;
    directHost?.remove();
    directHost = null;
    document.getElementById("gutter-check-mount")!.replaceChildren();
  },
};

// Font readiness gates every fit-dependent observation: the cell metrics the
// gutter sizes itself from are wrong until the real mono font has loaded.
void document.fonts.ready.then(() => {
  window.__gutterCheckReady = true;
});
