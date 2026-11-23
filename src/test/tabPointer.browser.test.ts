import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Pointer conventions on the tab strip: middle-click closes a tab, a pinned
 * tab is immune to that gesture, and right-clicking the strip itself offers
 * "Reopen Closed Tab" — disabled until there is something to reopen.
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

const tab = (id: string, number: number, pinned = false): Tab => ({
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
  pinned,
});

const tabElement = (id: string) =>
  document.querySelector<HTMLElement>('.tab[data-tab-id="' + id + '"]');
const ids = () => useStore.getState().tabs.map((item) => item.info.id);
const middleClick = (element: Element) => {
  element.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
};
const until = async (predicate: () => boolean, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(20);
};
const strip = () => document.querySelector<HTMLElement>('.tabstrip[data-pane-id="root"]');

const mountTwo = async (second: Tab) => {
  await page.viewport(1440, 900);
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.setState({
    ...initial,
    tabs: [tab("a", 1), second],
    activeId: "a",
    panes: [{ id: "root", activeTabId: "a" }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
    closedTabs: [],
  });
  useStore.getState().setLanguage("en");
  mount(h(App));
  await twoFrames();
  await twoFrames();
};

describe("pointer conventions on tabs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController("a");
    disposeController("b");
    useStore.setState(initial, true);
  });

  it("asks before closing a live tab, the way the close button does", async () => {
    await mountTwo(tab("b", 2));
    middleClick(tabElement("b")!);
    await twoFrames();
    expect(useStore.getState().closePrompt).toEqual(["b"]);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("closes an already ended tab without asking", async () => {
    await mountTwo({ ...tab("b", 2), state: "closed" });
    middleClick(tabElement("b")!);
    await until(() => ids().length === 1);
    expect(ids()).toEqual(["a"]);
    expect(useStore.getState().closePrompt).toBeNull();
  });

  it("never closes a pinned tab with the middle button, not even to ask", async () => {
    await mountTwo(tab("b", 2, true));
    expect(tabElement("b")!.classList.contains("is-pinned")).toBe(true);
    middleClick(tabElement("b")!);
    await twoFrames();
    expect(ids()).toEqual(["a", "b"]);
    expect(useStore.getState().closePrompt).toBeNull();
  });

  it("offers Reopen Closed Tab on the strip, disabled until something closed", async () => {
    await mountTwo(tab("b", 2));
    const menu = async () => {
      strip()!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 60,
        }),
      );
      await twoFrames();
      return document.querySelector<HTMLElement>('[role="menu"]');
    };
    const item = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((node) =>
        node.textContent?.includes("Reopen Closed Tab"),
      );

    const empty = await menu();
    expect(empty, "the strip answers a right click").not.toBeNull();
    expect(item(empty!)?.disabled).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await twoFrames();

    const seed = tab("z", 9);
    useStore.setState({ closedTabs: [{ info: seed.info, profile: seed.profile }] });
    const filled = await menu();
    expect(filled).not.toBeNull();
    expect(item(filled!)?.disabled).toBe(false);
  });
});
