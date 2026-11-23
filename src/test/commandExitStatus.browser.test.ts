import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * A shell that announces its exit status (OSC 133 D) gets it reported: a
 * failing command says so in the status line, and a successful one adds no
 * noise. A shell without that integration stays silent — the command tracker
 * cannot invent a status.
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();
const ID = "exit-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "exit",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-exit",
    address: "exit.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-exit", name: "exit", kind: "ssh", host: "exit.internal", username: "deploy" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const statusText = () =>
  document.querySelector<HTMLElement>(".status-message-text")?.textContent ?? "";

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(40);
};

describe("command exit status", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("reports a failing command and stays quiet for a successful one", async () => {
    await page.viewport(1100, 720);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
    await twoFrames();
    const controller = getController(ID)!;

    const write = (text: string) =>
      new Promise<void>((resolve) => controller.term.write(text, resolve));

    await write("\x1b]133;C\x07");
    await write("false\r\n");
    await write("\x1b]133;D;7\x07");
    await until(() => statusText().includes("exited with status 7"));
    expect(statusText()).toBe("Command exited with status 7");

    // The failed command also keeps a mark in the gutter: its start row wears
    // the error ink, so the failure is still findable after the status line
    // moves on.
    const failedRows = () => document.querySelectorAll(".gutter-row.is-failed").length;
    await until(() => failedRows() === 1);
    expect(failedRows(), "one failed command is marked").toBe(1);
    expect(
      document.querySelectorAll(".gutter-row.is-command").length,
      "the mark is still a command boundary",
    ).toBeGreaterThanOrEqual(1);

    // A successful command does not repeat or keep the failure message.
    useStore.getState().setStatus("");
    await write("\x1b]133;C\x07");
    await write("true\r\n");
    await write("\x1b]133;D;0\x07");
    await twoFrames();
    expect(statusText()).not.toContain("exited with status");
    expect(failedRows(), "a successful command adds no failed mark").toBe(1);
  });

  it("walks to the failed command from the palette and says when there is none", async () => {
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.getState().setLanguage("en");
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
    await twoFrames();
    const controller = getController(ID)!;
    const write = (text: string) =>
      new Promise<void>((resolve) => controller.term.write(text, resolve));

    await write("\x1b]133;C\x07");
    await write("false\r\n");
    await write("\x1b]133;D;7\x07");
    await write("\x1b]133;C\x07");
    await write("true\r\n");
    await write("\x1b]133;D;0\x07");
    await twoFrames();
    const [failed] = controller.failedCommandLines();
    const before = controller.term.buffer.active.viewportY;

    const openPalette = async () => {
      await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
      await until(() => document.querySelector(".command-palette-input") !== null);
      await twoFrames();
      await userEvent.keyboard("previous failed");
      await twoFrames();
    };
    const option = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".command-palette-option")).find((node) =>
        node.textContent?.includes("Previous Failed Command"),
      );

    await openPalette();
    expect(useStore.getState().language, "the palette follows the app language").toBe("en");
    expect(option(), "the command is listed even without a default chord").toBeDefined();
    await userEvent.click(option()!);
    await twoFrames();
    // The walk landed on the failed command's line. The fixture is short
    // enough that the line is already on screen, so this asserts the landing
    // itself rather than a scroll delta.
    expect(controller.term.buffer.active.viewportY, "the failed line came into view").toBe(failed);
    expect(before, "and it was already visible").toBe(failed);
    expect(useStore.getState().status, "the jump said nothing because it worked").not.toContain(
      "No failed command",
    );

    // Walking past the only failure says so instead of doing nothing.
    useStore.getState().setStatus("");
    await openPalette();
    await userEvent.click(option()!);
    await twoFrames();
    expect(useStore.getState().status).toBe("No failed command to jump to");
  });
});
