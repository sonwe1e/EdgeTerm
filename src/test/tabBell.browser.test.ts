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
 * A background session that asks for attention badges its tab. The bell the
 * shell prints (BEL) is the one signal every shell already sends when it wants
 * the user back; selecting the tab acknowledges it.
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

const tab = (id: string, paneId: string): Tab => ({
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
  profile: { id: "p-" + id, name: id, kind: "ssh", host: id + ".internal", username: "ops" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId,
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(20);
};

const bellOn = (id: string) => document.querySelector(`[data-tab-id="${id}"] .tab-bell`) !== null;

describe("tab bell", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController("build");
    disposeController("db");
    useStore.setState(initial, true);
  });

  it("badges the tab that rang and clears when it is selected", async () => {
    await page.viewport(1200, 720);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab("build", "left"), tab("db", "right")],
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
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController("build")?.term.element?.isConnected).toBe(true);
    await expect.poll(() => getController("db")?.term.element?.isConnected).toBe(true);
    await twoFrames();
    expect(bellOn("db"), "no badge before the bell").toBe(false);

    // BEL from the other session: the badge appears on its tab only.
    const db = getController("db")!;
    await new Promise<void>((resolve) => db.term.write("\x07", resolve));
    await until(() => bellOn("db"));
    expect(bellOn("db"), "the background tab is badged").toBe(true);
    expect(bellOn("build"), "the focused tab is not").toBe(false);

    // Selecting it is the acknowledgement.
    await userEvent.click(document.querySelector('[data-tab-id="db"]')!);
    await twoFrames();
    await until(() => !bellOn("db"));
    expect(bellOn("db"), "selecting clears the badge").toBe(false);
  });

  it("does not badge a tab whose session has closed", async () => {
    await page.viewport(1200, 720);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [
        { ...tab("build", "left") },
        { ...tab("db", "right"), attention: true, state: "closed" },
      ],
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
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
    await twoFrames();
    expect(bellOn("db"), "a closed tab keeps no attention badge").toBe(false);
  });
});
