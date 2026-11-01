import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import App from "../App";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

// P0 acceptance for Alt+click cursor positioning. Real App, real xterm and
// real Chromium pointer input; only the native host is a fixture. What this
// proves is the terminal contract (xterm emits the cursor-walk sequences on
// mouseup and our input path forwards them verbatim); WebView2 behaviour is
// still a separate acceptance item.
const ALT = 1;
const initial = useStore.getState();
const writes: { command: string; args: unknown }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: unknown) {
    if (command === "write_session" || command === "write_session_bytes") {
      writes.push({ command, args });
    }
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "local_home") return "C:/fixture";
    if (command === "local_list") return { path: "C:/fixture", entries: [] };
    if (command === "plugin:app|version") return "1.5.1";
    if (command === "portable_mode") return false;
    return null;
  },
};

const id = "mouse-target";
async function fixture() {
  await page.viewport(1440, 900);
  const paneId = initial.activePaneId;
  const tab: Tab = {
    info: {
      id,
      name: id,
      kind: "local",
      protocol: "local",
      profileId: null,
      address: "fixture",
      color: null,
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "local" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId,
  };
  useStore.setState({
    tabs: [tab],
    activeId: id,
    panes: [{ id: paneId, activeTabId: id }],
    language: "en",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  mount(h(App));
  await expect.poll(() => getController(id)?.term.element?.isConnected).toBe(true);
  await twoFrames();
  const controller = getController(id)!;
  controller.focus();
  writes.length = 0;
  return controller;
}

async function output(text: string) {
  const controller = getController(id)!;
  await new Promise<void>((resolve) => controller.term.write(text, resolve));
  await twoFrames();
  writes.length = 0;
}

/** The text the terminal actually sent to the session, in order. */
function sent(): string {
  return writes
    .filter(({ command }) => command === "write_session")
    .map(({ args }) => (args as { data: string }).data)
    .join("");
}

function binaryBytes(): Uint8Array[] {
  return writes
    .filter(({ command }) => command === "write_session_bytes")
    .map(({ args }) => args as Uint8Array);
}

function cellPoint(col: number, row: number) {
  const screen = document.querySelector(".pane-slot:not(.is-hidden) .xterm-screen");
  if (!screen) throw new Error("no terminal screen on screen");
  const cols = getController(id)!.term.cols;
  const rows = getController(id)!.term.rows;
  return pagePoint(screen, (col + 0.5) / cols, (row + 0.5) / rows);
}

async function altClick(col: number, row: number) {
  const { x, y } = cellPoint(col, row);
  await mouse.press(x, y, ALT);
  await mouse.release(x, y, ALT);
  await twoFrames();
}

afterEach(async () => {
  await browserAfterEach();
  disposeController(id);
  useStore.setState(initial, true);
  writes.length = 0;
});

it("walks the shell cursor left with Alt+click and keeps the click in the normal buffer", async () => {
  const controller = await fixture();
  await output("user@edge:~$ echo hi");
  expect(controller.term.buffer.active.type).toBe("normal");
  const cursorBefore = controller.term.buffer.active.cursorX;
  expect(cursorBefore).toBe(20);
  await altClick(2, 0);
  // 20 → 2 is 18 cells left, which xterm walks with CSI D sequences.
  expect(sent()).toBe("\x1b[D".repeat(18));
  expect(controller.term.hasSelection()).toBe(false);
  expect(controller.term.buffer.active.cursorX).toBe(cursorBefore);
});

it("counts wide characters once per cell so a CJK command line lands where it was clicked", async () => {
  await fixture();
  await output("中文中文中文");
  expect(getController(id)!.term.buffer.active.cursorX).toBe(12);
  await altClick(0, 0);
  // Six double-width cells: the walk is 12 cells, not 6 characters.
  expect(sent()).toBe("\x1b[D".repeat(12));
});

it("leaves Alt+click to a program that tracks the mouse", async () => {
  const controller = await fixture();
  await output("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
  expect(controller.term.modes.mouseTrackingMode).not.toBe("none");
  await altClick(4, 2);
  const data = sent();
  expect(data).not.toBe("");
  expect(data).not.toContain("\x1b[D");
  // SGR report: the 8 bit in the button code is the Alt modifier, so the
  // program sees the modified click rather than a cursor walk.
  for (const report of data.split("\x1b[<").slice(1)) {
    expect(report).toMatch(/^\d+;\d+;\d+[Mm]$/);
  }
  expect(binaryBytes()).toEqual([]);
});

it("does not move the cursor while the viewport is scrolled back into history", async () => {
  const controller = await fixture();
  await output("history line\r\n".repeat(200));
  const { x, y } = cellPoint(2, 3);
  await mouse.wheel(x, y, -600);
  await twoFrames();
  expect(controller.term.buffer.normal.viewportY).toBeLessThan(controller.term.buffer.normal.baseY);
  await altClick(2, 3);
  expect(sent()).toBe("");
});
