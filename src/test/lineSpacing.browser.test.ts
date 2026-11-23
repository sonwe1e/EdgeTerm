import { createElement as h, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Line spacing, end to end: the display dialog writes the setting, the pane
 * applies it to the live terminal, and the terminal re-fits — more rows when
 * the spacing shrinks, fewer when it grows, with the gutter keeping its own
 * cell height in step. Only the native host is a stub.
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
const ID = "spacing-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "spacing",
    kind: "local",
    protocol: "local",
    profileId: null,
    address: "local",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-spacing", name: "spacing", kind: "local" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const openDisplaySettings = async () => {
  await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
  await twoFrames();
  const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, "Display Settings");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
  );
  await until(
    () =>
      document.querySelector(".command-palette-input") === null &&
      document.querySelector("dialog[open]") !== null,
  );
  await twoFrames();
  return document.querySelector<HTMLDialogElement>("dialog[open]")!;
};

/** Sets the spacing select and submits the dialog. */
const applySpacing = async (value: string) => {
  const dialog = await openDisplaySettings();
  const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Line spacing"]');
  expect(select, "the spacing control exists").not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select!, value);
  select!.dispatchEvent(new Event("change", { bubbles: true }));
  await twoFrames();
  const apply = dialog.querySelector<HTMLButtonElement>(".btn.is-primary")!;
  await userEvent.click(apply);
  await until(() => document.querySelector("dialog[open]") === null);
  await twoFrames();
};

describe("line spacing", () => {
  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
    localStorage.clear();
  });

  // Three dialog round-trips, each with a keyboard-driven palette lookup and a
  // terminal refit. On a loaded machine that can pass the 15 s default, which
  // is a limit of the harness, not of the behaviour being asserted; see the
  // timeout note at the end of the test.
  it("re-fits the terminal when the spacing changes, and remembers it", async () => {
    await page.viewport(1280, 800);
    localStorage.removeItem("edgeterm.lineHeight");
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      gpuRenderer: false,
      gutterMode: "both",
      panels: { sessions: false, filer: false, sender: false },
      lineHeight: 1.25,
    });
    // After the state reset: the setter publishes the language for both the
    // translator and useT, which the reset would otherwise put back.
    useStore.getState().setLanguage("en");
    mount(h(StrictMode, null, h(App)));
    await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
    await twoFrames();
    const controller = getController(ID)!;
    await until(() => controller.term.options.lineHeight === 1.25);
    const baseline = controller.term.rows;
    const cellHeight = () =>
      document.querySelector<HTMLElement>(".xterm-rows > div")?.getBoundingClientRect().height ?? 0;
    const cellBefore = cellHeight();
    expect(cellBefore, "the terminal reports a row height").toBeGreaterThan(0);

    await applySpacing("1");
    await until(() => controller.term.options.lineHeight === 1);
    expect(controller.term.options.lineHeight, "the terminal took the setting").toBe(1);
    await until(() => controller.term.rows !== baseline);
    expect(controller.term.rows, "tighter rows fit more of them").toBeGreaterThan(baseline);

    const tight = controller.term.rows;
    await applySpacing("1.55");
    await until(() => controller.term.options.lineHeight === 1.55);
    expect(controller.term.rows, "looser rows fit fewer").toBeLessThan(tight);
    expect(localStorage.getItem("edgeterm.lineHeight"), "the choice is remembered").toBe("1.55");

    // The gutter keeps its own cell height, measured from the DOM: if it did
    // not follow the spacing, the line numbers would slide off their rows.
    expect(cellHeight(), "the rendered cell grew with the spacing").toBeGreaterThan(cellBefore);
    const gutterRow = document.querySelector<HTMLElement>(".term-gutter .gutter-row")!;
    expect(gutterRow.getBoundingClientRect().height).toBeCloseTo(cellHeight(), 0);
  }, 30000);
});
