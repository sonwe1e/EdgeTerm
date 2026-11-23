import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * Pinned tabs: the pin moves the tab to the front of its own strip and the
 * strip shows the pin. "Close Others" leaving pinned tabs alone is pinned by
 * the unit test, which exercises the same helper the menu calls.
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

const tab = (id: string, number: number): Tab => ({
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
  paneId: "root",
});

const stripIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tabstrip [role="tab"]')).map(
    (node) => node.dataset.tabId ?? "",
  );

describe("pinned tabs", () => {
  afterEach(async () => {
    await browserAfterEach();
    for (const open of useStore.getState().tabs) disposeController(open.info.id);
    useStore.setState(initial, true);
  });

  it("moves the pinned tab to the front and marks it in the strip", async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab("a", 1), tab("b", 2), tab("c", 3)],
      activeId: "a",
      panes: [{ id: "root", activeTabId: "a" }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
    await twoFrames();
    expect(stripIds()).toEqual(["a", "b", "c"]);

    useStore.getState().toggleTabPinned("c");
    await twoFrames();
    expect(stripIds(), "the pinned tab went first").toEqual(["c", "a", "b"]);
    const pinned = document.querySelector<HTMLElement>('.tab[data-tab-id="c"]')!;
    expect(pinned.classList.contains("is-pinned")).toBe(true);
    expect(pinned.querySelector(".tab-pin"), "the pin is visible").not.toBeNull();
    expect(document.querySelectorAll(".tab-pin").length, "only one pin").toBe(1);
    expect(
      document.querySelector<HTMLElement>('.tab[data-tab-id="a"]')!.querySelector(".tab-pin"),
    ).toBeNull();
  });
});
