import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * The docks' boundaries already reset on double-click; a pane boundary used to
 * ignore the same gesture. This pins that both splits of the app answer it —
 * the gesture a reader tries without being told.
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

const widths = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".pane-slot"))
    .filter((node) => getComputedStyle(node).display !== "none")
    .map((node) => Math.round(node.getBoundingClientRect().width));

describe("splitter reset", () => {
  afterEach(async () => {
    await browserAfterEach();
    for (const open of useStore.getState().tabs) disposeController(open.info.id);
    useStore.setState(initial, true);
  });

  it("evens a dragged pane split on double-click", async () => {
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
        sizes: [0.7, 0.3],
      },
      activePaneId: "left",
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
    await twoFrames();

    const before = widths();
    expect(before.length).toBe(2);
    expect(before[0], "starts at the dragged ratio").toBeGreaterThan(before[1] + 100);

    const splitter = document.querySelector<HTMLElement>(".pane-splitter")!;
    await userEvent.dblClick(splitter);
    await twoFrames();

    const layout = useStore.getState().layout;
    expect(layout.kind === "split" && layout.sizes).toEqual([0.5, 0.5]);
    const after = widths();
    expect(Math.abs(after[0] - after[1]), "both sides are the same width").toBeLessThanOrEqual(2);
  });
});
