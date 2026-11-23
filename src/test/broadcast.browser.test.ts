import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * Synchronized input end to end: real App, real xterm, real keystrokes. Only
 * the native host is a stub, and it records every write_session call, which is
 * exactly the point being proven — one keystroke must reach both shells, and
 * switching the mode off must leave the other shell alone.
 *
 * Boundary: synthetic keyboard input in Chromium over a controlled IPC stub.
 */

const WRITES: { id: string; data: string }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "write_session") {
      WRITES.push({ id: String(args.id), data: String(args.data) });
    }
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();

const tab = (id: string, number: number, paneId: string): Tab => ({
  info: {
    id,
    name: id,
    kind: "ssh",
    protocol: "ssh",
    profileId: null,
    address: id + ".internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-" + id, name: id, kind: "ssh" },
  number,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId,
});

const fixture = async (oneSession = false, withEdge = false) => {
  await page.viewport(1440, 900);
  useStore.getState().setShortcuts(defaultShortcuts());
  const left = tab("build", 1, "left");
  const right = tab("db", 2, "right");
  // A third shell behind the strip: connected, but its pane shows another tab.
  const edge = tab("edge", 3, "left");
  useStore.setState({
    ...initial,
    tabs: oneSession ? [left] : withEdge ? [left, right, edge] : [left, right],
    activeId: "build",
    panes: oneSession
      ? [{ id: "left", activeTabId: "build" }]
      : [
          { id: "left", activeTabId: "build" },
          { id: "right", activeTabId: "db" },
        ],
    layout: oneSession
      ? { kind: "leaf", paneId: "left" }
      : {
          kind: "split",
          direction: "row",
          children: [
            { kind: "leaf", paneId: "left" },
            { kind: "leaf", paneId: "right" },
          ],
          sizes: [0.5, 0.5],
        },
    activePaneId: "left",
    // The module-level translator reads the language the store publishes, so
    // the fixture goes through the setter rather than writing the field.
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
    broadcastInput: false,
  });
  useStore.getState().setLanguage("en");
  mount(h(App));
  await expect.poll(() => getController("build")?.term.element?.isConnected).toBe(true);
  await twoFrames();
  if (!oneSession) {
    await expect.poll(() => getController("db")?.term.element?.isConnected).toBe(true);
  }
  // "edge" stays a background tab: broadcast writes to the session, not to a
  // mounted terminal, so no controller is expected for it.
  getController("build")!.focus();
  await twoFrames();
  WRITES.length = 0;
};

/** Runs a command through the palette, keyboard only. */
const runPaletteCommand = async (query: string) => {
  await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
  await twoFrames();
  const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, query);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
  );
  await twoFrames();
};

const written = (id: string) =>
  WRITES.filter((write) => write.id === id)
    .map((write) => write.data)
    .join("");

describe("synchronized input", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    for (const tab of useStore.getState().tabs) disposeController(tab.info.id);
    useStore.setState(initial, true);
    WRITES.length = 0;
  });

  it("sends one keystroke to every connected shell, and stops when switched off", async () => {
    await fixture();
    await runPaletteCommand("Broadcast Input");
    const indicator = document.querySelector<HTMLElement>(".status-item.is-broadcasting");
    expect(indicator, "the status bar reports the live mode").not.toBeNull();
    // Two sessions open, one other shell: the count is the number of
    // recipients, not the number of tabs.
    expect(indicator!.textContent).toContain("1");

    getController("build")!.focus();
    WRITES.length = 0;
    await userEvent.keyboard("ls");
    await twoFrames();
    expect(written("build")).toBe("ls");
    expect(written("db"), "the other shell received the same keystrokes").toBe("ls");

    // The indicator is the off switch as well as the warning.
    await userEvent.click(indicator!);
    await twoFrames();
    expect(document.querySelector(".status-item.is-broadcasting")).toBeNull();
    getController("build")!.focus();
    WRITES.length = 0;
    await userEvent.keyboard("pwd");
    await twoFrames();
    expect(written("build")).toBe("pwd");
    expect(WRITES.some((write) => write.id === "db")).toBe(false);
  });

  it("refuses to switch on when no other shell is connected", async () => {
    await fixture(true);
    await runPaletteCommand("Broadcast Input");
    expect(document.querySelector(".status-item.is-broadcasting")).toBeNull();
    expect(useStore.getState().broadcastInput).toBe(false);
    expect(useStore.getState().status).toBe(
      "Open another connected shell session before broadcasting input",
    );
  });

  it("turns itself off when the last other shell goes away", async () => {
    await fixture();
    await runPaletteCommand("Broadcast Input");
    expect(useStore.getState().broadcastInput).toBe(true);
    useStore.getState().closeTab("db");
    await twoFrames();
    await twoFrames();
    expect(useStore.getState().broadcastInput, "no recipients left").toBe(false);
    expect(document.querySelector(".status-item.is-broadcasting")).toBeNull();
  });

  it("lets the reader leave a shell out, and turns itself off when none are left", async () => {
    await fixture(false, true);
    await runPaletteCommand("Broadcast Input");
    const indicator = document.querySelector<HTMLElement>(".status-item.is-broadcasting")!;
    expect(indicator.textContent, "both peers are recipients").toContain("2");

    // The caret opens the recipients; the indicator still turns the mode off.
    const caret = document.querySelector<HTMLButtonElement>(".broadcast-targets-button")!;
    expect(caret, "the targets caret").not.toBeNull();
    await userEvent.click(caret);
    await twoFrames();
    const popover = document.querySelector<HTMLElement>(".broadcast-popover")!;
    expect(popover, "the targets popover").not.toBeNull();
    const peerRows = Array.from(popover.querySelectorAll<HTMLElement>(".broadcast-peer"));
    expect(peerRows.length, "one row per connected peer").toBe(2);

    const dbRow = peerRows.find((row) => (row.textContent ?? "").includes("db"))!;
    const dbBox = dbRow.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    await userEvent.click(dbBox);
    await twoFrames();
    expect(useStore.getState().broadcastExcluded).toEqual(["db"]);
    expect(indicator.textContent, "the count drops with the exclusion").toContain("1");

    // One keystroke reaches the remaining peer and the background tab, not
    // the shell that was unchecked.
    getController("build")!.focus();
    WRITES.length = 0;
    await userEvent.keyboard("ls");
    await twoFrames();
    expect(written("build")).toBe("ls");
    expect(written("edge"), "the included background shell").toBe("ls");
    expect(written("db"), "the unchecked shell is left alone").toBe("");

    // Unchecking the last recipient ends the mode rather than leaving a live
    // indicator with nowhere to write.
    const edgeRow = peerRows.find((row) => (row.textContent ?? "").includes("edge"))!;
    await userEvent.click(edgeRow.querySelector<HTMLInputElement>("input[type='checkbox']")!);
    await twoFrames();
    expect(useStore.getState().broadcastInput, "no recipients left").toBe(false);
    expect(document.querySelector(".status-item.is-broadcasting")).toBeNull();
    expect(
      document.querySelector(".broadcast-popover"),
      "the popover closes with the mode",
    ).toBeNull();
    expect(useStore.getState().status).toBe("Broadcast input off");
  });

  it("leaves a whole group out of synchronized input from the targets popover", async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    const build = tab("build", 1, "left");
    const db = {
      ...tab("db", 2, "right"),
      profile: { ...tab("db", 2, "right").profile, groupId: "prod" },
    };
    const edge = tab("edge", 3, "left");
    useStore.setState({
      ...initial,
      tabs: [build, db, edge],
      activeId: "build",
      panes: [
        { id: "left", activeTabId: "build" },
        { id: "right", activeTabId: "db" },
      ],
      layout: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "leaf", paneId: "left" },
          { kind: "leaf", paneId: "right" },
        ],
        sizes: [0.5, 0.5],
      },
      activePaneId: "left",
      groups: [{ id: "prod", name: "Production", kind: "ssh", parentId: null }],
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
      broadcastInput: false,
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController("build")?.term.element?.isConnected).toBe(true);
    await expect.poll(() => getController("db")?.term.element?.isConnected).toBe(true);
    await twoFrames();
    getController("build")!.focus();
    await twoFrames();
    // App loadGroups() replaces the store's groups from the host on mount, and
    // the stub returns none; pin the group after that load instead.
    useStore.setState((state) => ({
      groups: [{ id: "prod", name: "Production", kind: "ssh", parentId: null }],
      tabs: state.tabs.map((item) =>
        item.info.id === "db" ? { ...item, profile: { ...item.profile, groupId: "prod" } } : item,
      ),
    }));
    await twoFrames();

    useStore.getState().setBroadcastInput(true);
    await twoFrames();
    WRITES.length = 0;
    // The popover lists the group that holds a target.
    await userEvent.click(document.querySelector<HTMLElement>(".broadcast-targets-button")!);
    await twoFrames();
    const groupRow = Array.from(
      document.querySelectorAll<HTMLElement>(".broadcast-groups label"),
    ).find((node) => node.textContent?.includes("Group: Production"));
    expect(groupRow, "the group is offered as a switch").toBeDefined();
    const box = groupRow!.querySelector<HTMLInputElement>("input")!;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    await twoFrames();
    expect(useStore.getState().broadcastExcludedGroups).toEqual(["prod"]);

    // Typing now reaches the ungrouped shell only.
    getController("build")!.focus();
    await twoFrames();
    await userEvent.keyboard("x");
    await twoFrames();
    expect(written("db"), "the excluded group received nothing").toBe("");
    expect(written("edge").length, "the ungrouped shell still got the key").toBeGreaterThan(0);

    // Re-checking the group puts it back in the blast radius.
    WRITES.length = 0;
    await userEvent.click(box);
    await twoFrames();
    expect(useStore.getState().broadcastExcludedGroups).toEqual([]);
    getController("build")!.focus();
    await twoFrames();
    await userEvent.keyboard("y");
    await twoFrames();
    expect(written("db").length, "the group received the key again").toBeGreaterThan(0);
  });
});
