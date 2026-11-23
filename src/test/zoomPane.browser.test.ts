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
 * Pane zoom: the focused pane takes the whole terminal area, the split comes
 * back exactly as it was, and — the part that is easy to get wrong — the other
 * panes' terminals stay mounted while hidden, so a zoom never costs scrollback.
 *
 * Boundary: Chromium over a controlled IPC stub, two panes side by side.
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

const tab = (id: string, number: number, paneId: string): Tab => ({
  info: {
    id,
    name: id,
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-" + id,
    address: id + ".internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-" + id, name: id, kind: "ssh", host: id + ".internal", username: "deploy" },
  number,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId,
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const slots = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".pane-slot")).map((node) => ({
    node,
    width: node.getBoundingClientRect().width,
    display: getComputedStyle(node).display,
  }));

const fixture = async () => {
  await page.viewport(1440, 900);
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.setState({
    ...initial,
    tabs: [tab("build", 1, "left"), tab("db", 2, "right")],
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
    zoomedPaneId: null,
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  useStore.getState().setLanguage("en");
  mount(h(App));
  await expect.poll(() => getController("build")?.term.element?.isConnected).toBe(true);
  await expect.poll(() => getController("db")?.term.element?.isConnected).toBe(true);
  await twoFrames();
};

describe("pane zoom", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    for (const open of useStore.getState().tabs) disposeController(open.info.id);
    useStore.setState(initial, true);
  });

  it("fills the area with the focused pane and keeps the hidden terminal mounted", async () => {
    await fixture();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const workspaceWidth = workspace.getBoundingClientRect().width;
    const before = slots();
    expect(before.length, "one slot per session").toBe(2);
    expect(before[0].width, "the split is half and half").toBeCloseTo(workspaceWidth / 2, 0);

    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await until(() => useStore.getState().zoomedPaneId !== null);
    await twoFrames();
    expect(useStore.getState().zoomedPaneId).toBe("left");

    const zoomed = slots();
    const build = zoomed.find((slot) => slot.node.textContent !== undefined && slot.width > 0)!;
    const hidden = zoomed.filter((slot) => slot.display === "none");
    expect(zoomed.length, "both sessions are still mounted").toBe(2);
    expect(hidden.length, "the other pane is hidden, not unmounted").toBe(1);
    expect(build.width, "the zoomed pane fills the terminal area").toBeCloseTo(workspaceWidth, 0);
    expect(getController("db")?.term.element?.isConnected, "scrollback survives the zoom").toBe(
      true,
    );
    expect(document.querySelectorAll(".pane-splitter").length, "no splitters to drag").toBe(0);
    expect(document.querySelectorAll(".pane").length, "only the zoomed pane is laid out").toBe(1);

    // The same chord restores the split exactly: same two panes, same halves.
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await until(() => useStore.getState().zoomedPaneId === null);
    await twoFrames();
    const restored = slots();
    expect(restored.length).toBe(2);
    expect(restored.every((slot) => slot.display !== "none")).toBe(true);
    expect(restored[0].width).toBeCloseTo(workspaceWidth / 2, 0);
    expect(document.querySelectorAll(".pane-splitter").length, "the divider is back").toBe(1);
  });
});
