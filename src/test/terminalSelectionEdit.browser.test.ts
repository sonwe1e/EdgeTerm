import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import App from "../App";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

// P0 acceptance for editing a mouse selection on the shell's input line.
// Real App, real xterm, real Chromium pointer input and real keydown; only
// the native host is a fixture. What this proves is the whole contract:
// the drag makes a selection, our key filter answers it by sending the
// cursor-walk + forward-delete sequences to the session in order, and a
// printable key follows its delete. WebView2 behaviour stays a separate
// acceptance item, as for terminalAltClick.browser.test.ts.
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

const id = "selection-edit";
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

function cellPoint(col: number, row: number, fraction = 0.5) {
  const screen = document.querySelector(".pane-slot:not(.is-hidden) .xterm-screen");
  if (!screen) throw new Error("no terminal screen on screen");
  const cols = getController(id)!.term.cols;
  const rows = getController(id)!.term.rows;
  return pagePoint(screen, (col + fraction) / cols, (row + 0.5) / rows);
}

/**
 * Drags a selection across [fromCol, toCol) on a row. xterm takes the
 * release cell as the selection's exclusive end, so releasing on the cell
 * after the last wanted character selects exactly the intended span. The
 * pointer is placed a quarter into each cell: the selection service maps a
 * position right of a cell's midpoint onto the next cell, so a dead-centre
 * press (cellPoint's click default) selects one cell to the right.
 */
async function dragSelection(fromCol: number, toCol: number, row: number) {
  const start = cellPoint(fromCol, row, 0.25);
  await mouse.press(start.x, start.y);
  const mid = cellPoint(Math.floor((fromCol + toCol) / 2), row, 0.25);
  await mouse.moveTo(mid.x, mid.y);
  const end = cellPoint(toCol, row, 0.25);
  await mouse.moveTo(end.x, end.y);
  await mouse.release(end.x, end.y);
  await twoFrames();
}

/**
 * The bytes a pure delete sends: the walk left, the forward deletes, then the
 * walk right that puts the shell cursor back where it began.
 */
const walkDelete = (walkLeft: number, deletes: number) =>
  "\x1b[D".repeat(walkLeft) + "\x1b[3~".repeat(deletes) + "\x1b[C".repeat(walkLeft - deletes);

/** The same walk and delete without the walk back: a replacement's first half. */
const walkAndDelete = (walkLeft: number, deletes: number) =>
  "\x1b[D".repeat(walkLeft) + "\x1b[3~".repeat(deletes);

/** Waits until a replacement's walk back has reached the session. */
const settleRestore = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  await browserAfterEach();
  disposeController(id);
  useStore.setState(initial, true);
  writes.length = 0;
});

// "user@edge:~$ echo hi": the recognized prompt ends at column 12, "echo"
// sits at [13, 17), and the cursor at 20 — walking back 7 characters and
// forward-deleting 4 removes exactly the selected word.
it("deletes a dragged selection on the input line with Delete", async () => {
  const controller = await fixture();
  await output("user@edge:~$ echo hi");
  await dragSelection(13, 17, 0);
  expect(controller.term.getSelectionPosition()).toEqual({
    start: { x: 13, y: 0 },
    end: { x: 17, y: 0 },
  });

  await userEvent.keyboard("{Delete}");
  await twoFrames();
  expect(sent()).toBe(walkDelete(7, 4));
  expect(controller.term.hasSelection()).toBe(false);
});

it("replaces a dragged selection when a character is typed, delete first", async () => {
  const controller = await fixture();
  await output("user@edge:~$ echo hi");
  await dragSelection(13, 17, 0);
  expect(controller.term.hasSelection()).toBe(true);

  await userEvent.keyboard("X");
  await twoFrames();
  await settleRestore();
  expect(sent()).toBe(walkAndDelete(7, 4) + "X" + "\x1b[C".repeat(3));
  expect(controller.term.hasSelection()).toBe(false);
});

it("deletes a second selection after the shell has redrawn the line", async () => {
  const controller = await fixture();
  await output("user@edge:~$ echo hi");
  await dragSelection(13, 17, 0);
  await userEvent.keyboard("{Delete}");
  await twoFrames();
  // "echo" (walk 7, delete 4) and the three characters " hi" walked back over.
  expect(sent()).toBe(walkDelete(7, 4));

  // The shell redraws the shortened line and erases the stale tail; its
  // cursor is back at the end, where the first edit started.
  await output("\ruser@edge:~$  hi\x1b[K");
  expect(controller.term.buffer.active.cursorX).toBe(16);
  await dragSelection(14, 16, 0);
  await userEvent.keyboard("{Delete}");
  await twoFrames();
  // The second selection is editable again: walk 2, delete 2, nothing to walk
  // back over. Before the fix the cursor sat at column 13 and this reached
  // past it, so a single Delete went out instead.
  expect(sent()).toBe(walkDelete(2, 2));
});

it("keeps Delete on an output-line selection exactly as before", async () => {
  const controller = await fixture();
  await output("past output line\r\nuser@edge:~$ echo hi");
  await dragSelection(0, 4, 0);
  expect(controller.term.hasSelection()).toBe(true);

  await userEvent.keyboard("{Delete}");
  await twoFrames();
  // Not editable: xterm's own single Delete and nothing else — the
  // byte-for-byte behavior from before the feature.
  expect(sent()).toBe("\x1b[3~");
});
