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
 * Watch marks: a log line carrying an error or a warning tints its gutter row,
 * so a failure that scrolled past stays findable. The marks are painted on the
 * real gutter over real xterm output; the vocabulary itself is unit tested.
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
const ID = "watch-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "watch",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-watch",
    address: "watch.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-watch", name: "watch", kind: "ssh", host: "watch.internal", username: "ops" },
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

const marked = (kind: "error" | "warn") =>
  document.querySelectorAll(".gutter-row.is-watch-" + kind).length;

describe("watch marks", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("marks error and warning rows, and leaves ordinary output alone", async () => {
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

    await write("all good\r\n");
    await write("ERROR database is unreachable\r\n");
    await write("warning: unused variable\r\n");
    await write("0 errors, 2 warnings\r\n");

    await until(() => marked("error") === 1 && marked("warn") === 1);
    expect(marked("error"), "one error row is marked").toBe(1);
    expect(marked("warn"), "one warning row is marked").toBe(1);
    // "0 errors, 2 warnings" is a report, not a failure: plurals earn no mark.
    expect(
      document.querySelectorAll(".gutter-row.is-watch").length,
      "exactly two rows carry a watch mark",
    ).toBe(2);

    // The marks survive a clear-and-rewrite only when the text still has them.
    await write("\x1b[2J\x1b[H");
    await write("clean run\r\n");
    await until(() => document.querySelectorAll(".gutter-row.is-watch").length === 0);
    expect(
      document.querySelectorAll(".gutter-row.is-watch").length,
      "clearing the screen drops the marks",
    ).toBe(0);
  });

  it("walks to the next watch mark from the palette and says when there is none", async () => {
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

    // Two marked rows early in a buffer that ends well below them, so the
    // viewport starts on unmarked output.
    await write("ERROR early failure\r\n");
    for (let index = 0; index < 60; index += 1) await write("plain line " + index + "\r\n");
    await write("warning near the end\r\n");
    await write("all good\r\n");

    const runPalette = async (query: string) => {
      await controller.term.focus();
      await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
      await twoFrames();
      const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, query);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await twoFrames();
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await twoFrames();
    };

    await runPalette("Next Watch Mark");
    await until(() => document.querySelectorAll(".gutter-row.is-watch").length > 0);
    expect(
      document.querySelectorAll(".gutter-row.is-watch").length,
      "the jump lands on a marked row",
    ).toBeGreaterThan(0);

    // A cleared buffer has nothing to land on, and the app says so.
    await write("\x1b[2J\x1b[H");
    await write("clean run\r\n");
    await until(() => document.querySelectorAll(".gutter-row.is-watch").length === 0);
    useStore.getState().setStatus("");
    await runPalette("Next Watch Mark");
    await until(() => statusText().length > 0);
    expect(statusText()).toContain("No line in the buffer carries");
  });

  it("reports an empty walk from the menu too, not only from the palette", async () => {
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
    await new Promise<void>((resolve) => controller.term.write("clean run\r\n", resolve));
    await until(() => document.querySelectorAll(".gutter-row.is-watch").length === 0);

    // The menu goes through the same walk as the keyboard and the palette.
    const titles = Array.from(document.querySelectorAll<HTMLElement>("[id^='menu-title-']"));
    const view = titles.find((node) => node.textContent?.trim() === "View");
    expect(view, "the View menu").toBeDefined();
    await userEvent.click(view!);
    await twoFrames();
    const entry = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (node) => node.textContent?.trim().startsWith("Next Watch Mark"),
    );
    expect(entry, "the menu entry").toBeDefined();
    await userEvent.click(entry!);
    await until(() => statusText().length > 0);
    expect(statusText()).toContain("No line in the buffer carries");
  });
});
