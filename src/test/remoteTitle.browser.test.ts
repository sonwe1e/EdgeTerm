import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The program's own window title (OSC 0/2) reaches the status bar beside the
 * session details. It is transient text, so it never replaces the tab's name.
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
const ID = "title-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "title",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-title",
    address: "title.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-title", name: "title", kind: "ssh", host: "title.internal", username: "ops" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const barTitle = () =>
  document.querySelector<HTMLElement>(".status-remote-title")?.textContent?.trim() ?? "";

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(20);
};

describe("reported window title", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("shows the program's title beside the session, and follows a new one", async () => {
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

    expect(barTitle(), "nothing before the program says anything").toBe("");
    await write("\x1b]0;vim notes.txt\x07");
    await until(() => barTitle().length > 0);
    expect(barTitle()).toBe("vim notes.txt");
    expect(
      document.querySelector<HTMLElement>('[data-tab-id="' + ID + '"] .tab-label')?.textContent,
      "the tab keeps its own name",
    ).toBe("title");

    await write("\x1b]2;tail -f /var/log/syslog\x07");
    await until(() => barTitle() === "tail -f /var/log/syslog");
    expect(barTitle()).toBe("tail -f /var/log/syslog");
    // The full title stays available even when the bar has to ellipsise it.
    expect(
      document.querySelector<HTMLElement>(".status-remote-title")?.getAttribute("title"),
    ).toContain("tail -f /var/log/syslog");
  });

  it("drops the title when its session is no longer connected", async () => {
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
    await new Promise<void>((resolve) =>
      controller.term.write("\x1b]0;vim notes.txt\x07", resolve),
    );
    await until(() => barTitle().length > 0);
    expect(barTitle()).toBe("vim notes.txt");

    // The shell is gone; its last title must not keep describing the tab.
    useStore.setState((state) => ({
      tabs: state.tabs.map((item) => (item.info.id === ID ? { ...item, state: "closed" } : item)),
    }));
    await twoFrames();
    await until(() => barTitle() === "");
    expect(barTitle(), "a closed session shows no program title").toBe("");
  });
});
