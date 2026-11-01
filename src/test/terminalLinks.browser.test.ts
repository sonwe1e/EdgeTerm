import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import App from "../App";
import { useFileEditor } from "../fileEditor";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames, wait } from "./browserHarness";
import "../styles.css";

// Acceptance for the two terminal-to-Filer exits: the Filer following the
// shell's directory reports, and a Ctrl+click on a path printed by a command
// opening the built-in editor at that line. Real App, real xterm, real
// Chromium pointer input; the native host is a fixture.
const initial = useStore.getState();
const writes: { command: string; args: unknown }[] = [];
const calls: { command: string; args: unknown }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: unknown) {
    calls.push({ command, args });
    if (command === "write_session" || command === "write_session_bytes") {
      writes.push({ command, args });
    }
    if (command === "plugin:event|listen") return ++serial;
    if (command === "sftp_home") return "/home/edge";
    if (command === "sftp_list") {
      const target = (args as { path: string }).path;
      return { path: target, entries: [] };
    }
    if (command === "local_home") return "C:/fixture";
    if (command === "local_list") return { path: "C:/fixture", entries: [] };
    if (command === "session_cwd") return "/home/edge";
    if (command === "project_read_text") {
      const path = (args as { path: string }).path;
      return {
        path,
        content: "def forward(self, x):\n    return self.decoder(x)\n",
        hash: "hash",
        size: 48,
        encoding: "UTF-8",
        eol: "lf",
        bom: false,
      };
    }
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.5.1";
    if (command === "portable_mode") return false;
    return null;
  },
};

const id = "links-target";
const paneId = initial.activePaneId;

function tab(): Tab {
  return {
    info: {
      id,
      name: "edge",
      kind: "ssh",
      protocol: "ssh",
      profileId: "profile",
      address: "edge.example:22",
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: "profile", name: "edge", kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId,
  };
}

async function fixture() {
  await page.viewport(1440, 900);
  useStore.setState({
    tabs: [tab()],
    activeId: id,
    panes: [{ id: paneId, activeTabId: id }],
    language: "en",
    gpuRenderer: false,
    panels: { sessions: false, filer: true, sender: false },
  });
  mount(h(App));
  await expect.poll(() => getController(id)?.term.element?.isConnected).toBe(true);
  await twoFrames();
  const controller = getController(id)!;
  controller.focus();
  writes.length = 0;
  calls.length = 0;
  return controller;
}

async function output(text: string) {
  const controller = getController(id)!;
  await new Promise<void>((resolve) => controller.term.write(text, resolve));
  await twoFrames();
}

/** The last directory the Filer asked the backend to list. */
function listedPath(): string | undefined {
  const lists = calls.filter(({ command }) => command === "sftp_list");
  const last = lists[lists.length - 1];
  return last ? (last.args as { path: string }).path : undefined;
}

/** A point over one cell of the terminal screen. */
function cellPoint(col: number, row: number) {
  const screen = document.querySelector(".pane-slot:not(.is-hidden) .xterm-screen");
  if (!screen) throw new Error("no terminal screen on screen");
  const term = getController(id)!.term;
  return pagePoint(screen, (col + 0.5) / term.cols, (row + 0.5) / term.rows);
}

afterEach(async () => {
  await browserAfterEach();
  disposeController(id);
  useFileEditor.setState({
    target: null,
    file: null,
    content: "",
    busy: false,
    error: null,
    conflict: false,
    saved: false,
  });
  useStore.setState(initial, true);
  writes.length = 0;
  calls.length = 0;
});

it("moves the Filer to the directory a followed shell reports", async () => {
  await fixture();
  // Turning following on syncs once; this shell has not reported a directory
  // yet, so the backend is asked exactly once for the current one.
  await userEvent.click(document.querySelector('[aria-label="Follow terminal"]') as HTMLElement);
  await expect.poll(listedPath).toBe("/home/edge");
  expect(useStore.getState().filerFollow[id]).toBe("following");

  // The prompt hook's report arrives after a command ran elsewhere; the Filer
  // follows it once the burst settles.
  await output("\x1b]7;file://edge.example/home/edge/work\x07user@edge:~$ ");
  await wait(600);
  await expect.poll(listedPath).toBe("/home/edge/work");
  expect(writes).toEqual([]);
});

it("opens a path printed by a command at its line on Ctrl+click", async () => {
  const controller = await fixture();
  await output('File "/home/edge/train/model.py", line 238\r\n');
  // The path starts at character 6 of the line ("File \""), and xterm
  // underlines it from there; click inside its second cell with Ctrl held.
  const { x, y } = cellPoint(8, 0);
  await mouse.moveTo(x, y);
  await twoFrames();
  await mouse.press(x, y, 2);
  await mouse.release(x, y, 2);
  await expect.poll(() => useFileEditor.getState().target?.path).toBe("/home/edge/train/model.py");
  expect(useFileEditor.getState().target?.line).toBe(238);
  expect(calls.find(({ command }) => command === "project_read_text")?.args).toMatchObject({
    path: "/home/edge/train/model.py",
  });
  expect(controller.term.modes.mouseTrackingMode).toBe("none");
});
