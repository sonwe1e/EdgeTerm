import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import App from "../App";
import { IS_MAC } from "../platform";
import { defaultShortcuts, setActiveShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { useWorkbench } from "../workbench/store";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

// Real App, actions, xterm and IPC serialization; only the native host is a
// fixture. Native ConPTY acceptance is separate from this browser contract.
const initial = useStore.getState();
const initialWorkbench = useWorkbench.getState();
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
    if (command === "list_workspace_data") return { workspaces: [], experiments: [], runs: [] };
    if (command.startsWith("list_")) return [];
    if (command === "local_home") return "C:/fixture";
    if (command === "local_list") return { path: "C:/fixture", entries: [] };
    if (command === "plugin:app|version") return "1.5.1";
    if (command === "portable_mode") return false;
    return null;
  },
};

const ids = ["input-first", "input-second", "input-third"];
async function fixture() {
  await page.viewport(1440, 900);
  useWorkbench.getState().setView("terminals");
  useStore.getState().setShortcuts(defaultShortcuts());
  const paneId = initial.activePaneId;
  const tabs: Tab[] = ids.map((id, index) => ({
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
    number: index + 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId,
  }));
  useStore.setState({
    tabs,
    activeId: ids[0],
    panes: [{ id: paneId, activeTabId: ids[0] }],
    language: "en",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  mount(h(App));
  await expect.poll(() => getController(ids[0])?.term.element?.isConnected).toBe(true);
  await twoFrames();
  const controller = getController(ids[0])!;
  controller.focus();
  writes.length = 0;
  return controller;
}

async function output(text: string) {
  const controller = getController(ids[0])!;
  await new Promise<void>((resolve) => controller.term.write(text, resolve));
  await twoFrames();
  writes.length = 0;
}

async function wheel(delta: number) {
  const point = pagePoint(
    document.querySelector(".pane-slot:not(.is-hidden) .xterm-screen")!,
    0.8,
    0.3,
  );
  await mouse.wheel(point.x, point.y, delta);
  await twoFrames();
}

afterEach(async () => {
  await browserAfterEach();
  for (const id of ids) disposeController(id);
  useStore.setState(initial, true);
  useWorkbench.setState(initialWorkbench, true);
  setActiveShortcuts(initial.shortcuts);
  writes.length = 0;
});

it.skipIf(IS_MAC)(
  "cycles tabs with Ctrl+Tab and Ctrl+Shift+Tab from xterm without sending shell input",
  async () => {
    await fixture();
    await userEvent.keyboard("{Control>}{Tab}{/Control}");
    expect(useStore.getState().activeId).toBe(ids[1]);
    await userEvent.keyboard("{Control>}{Tab}{/Control}");
    expect(useStore.getState().activeId).toBe(ids[2]);
    await userEvent.keyboard("{Control>}{Tab}{/Control}");
    expect(useStore.getState().activeId).toBe(ids[0]);
    await userEvent.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
    expect(useStore.getState().activeId).toBe(ids[2]);
    expect(writes).toEqual([]);
  },
);

it("keeps Alt+Delete in the terminal, including repeated Alt keydown, and still opens the menu on bare Alt", async () => {
  const controller = await fixture();
  await userEvent.keyboard("{Alt>}{Delete}{/Alt}");
  await twoFrames();
  expect(document.querySelector(".menu-dropdown") === null).toBe(true);
  expect(document.activeElement).toBe(controller.term.textarea);
  expect(writes.some(({ args }) => (args as { data?: string }).data === "\x1b[3;3~")).toBe(true);

  const target = controller.term.textarea!;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }));
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Delete", code: "Delete", altKey: true, bubbles: true }),
  );
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Alt", altKey: true, repeat: true, bubbles: true }),
  );
  target.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
  await twoFrames();
  expect(document.querySelector(".menu-dropdown") === null).toBe(true);

  await userEvent.keyboard("{Alt}");
  await twoFrames();
  expect(document.querySelector(".menu-dropdown") !== null).toBe(true);
});

it("forwards legacy mouse wheel reports as raw bytes, including coordinates above ASCII", async () => {
  const controller = await fixture();
  await output("\x1b[?1049h\x1b[?1000h");
  expect(controller.term.modes.mouseTrackingMode).toBe("vt200");
  await wheel(-120);
  const binary = writes.filter(({ command }) => command === "write_session_bytes");
  expect(binary.length).toBeGreaterThan(0);
  const bytes = binary[0].args as Uint8Array;
  expect(Array.from(bytes.slice(0, 4))).toEqual([27, 91, 77, 96]);
  expect(bytes[4]).toBeGreaterThan(127);
  expect(writes.filter(({ command }) => command === "write_session")).toEqual([]);

  writes.length = 0;
  controller.setLocked(true);
  await wheel(120);
  expect(writes).toEqual([]);
});

it("forwards SGR wheel reports and keeps ordinary shell scrollback local", async () => {
  const controller = await fixture();
  await output("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
  await wheel(-120);
  expect(writes.length).toBeGreaterThan(0);
  expect(
    writes.every(
      ({ command, args }) =>
        command === "write_session" && /^\x1b\[<64;\d+;\d+M$/.test((args as { data: string }).data),
    ),
  ).toBe(true);
  await output("\x1b[?1000l\x1b[?1006l\x1b[?1049l" + "scrollback fixture\r\n".repeat(200));
  const before = controller.term.buffer.normal.viewportY;
  await wheel(-300);
  await expect.poll(() => controller.term.buffer.normal.viewportY).toBeLessThan(before);
  expect(writes).toEqual([]);
});
