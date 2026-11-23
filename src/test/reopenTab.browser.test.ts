import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Reopen Closed Tab, end to end: a real close (the store's own path, which
 * retires the controller and the connection) and then the chord everybody
 * presses to undo it. The reopened session must be a *new* session with the
 * same profile, not a resurrection of the retired one.
 *
 * Boundary: Chromium over a controlled IPC stub; the reopen's connect is a
 * stub, so the test asserts the tab it produces, not a live login.
 */

const OPENED: { profileId: string | null; name: string }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "open_session") {
      const profile = args.profile as { id?: string; name?: string } | undefined;
      OPENED.push({ profileId: profile?.id ?? null, name: profile?.name ?? "" });
      return null;
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

const fixture = async () => {
  await page.viewport(1440, 900);
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.setState({
    ...initial,
    tabs: [tab("build", 1, "root"), tab("db", 2, "root")],
    activeId: "db",
    panes: [{ id: "root", activeTabId: "db" }],
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

describe("reopen closed tab", () => {
  beforeEach(() => {
    OPENED.length = 0;
  });

  afterEach(async () => {
    await browserAfterEach();
    for (const open of useStore.getState().tabs) disposeController(open.info.id);
    useStore.setState(initial, true);
  });

  it("brings the newest closed session back on a fresh id, and says when there is none", async () => {
    await fixture();
    const before = useStore.getState().tabs.map((item) => item.info.id);
    expect(before).toEqual(["build", "db"]);

    // The store's own close path, the one the confirmation dialog calls.
    await useStore.getState().closeTab("db");
    await until(() => useStore.getState().tabs.length === 1);
    expect(useStore.getState().tabs.map((item) => item.info.id)).toEqual(["build"]);
    const closed = useStore.getState().closedTabs;
    expect(closed.length, "the close is remembered").toBe(1);
    expect(closed[0].profile.name).toBe("db");
    expect(closed[0].info.id).toBe("db");

    // Ctrl+Shift+T: the browser convention.
    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    await until(() => useStore.getState().tabs.length === 2);
    const reopened = useStore.getState().tabs[1];
    expect(reopened.profile.name, "same profile").toBe("db");
    expect(reopened.profile.id, "the same profile").toBe("p-db");
    expect(reopened.info.address, "dialled from the profile").toContain("db.internal");
    expect(reopened.info.id, "a fresh session id, not the retired one").not.toBe("db");
    expect(useStore.getState().closedTabs, "the stack is consumed").toEqual([]);
    // The tab exists before the connect reaches the host: wait for the call.
    await until(() => OPENED.length > 0);
    expect(OPENED.length, "a fresh connection was asked for").toBeGreaterThan(0);
    expect(OPENED[0].profileId, "the same profile dialled").toBe("p-db");

    // Nothing left: the mode says so instead of doing nothing silently.
    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    await twoFrames();
    expect(useStore.getState().status).toBe("There is no closed session to reopen");
    expect(useStore.getState().tabs.length, "no phantom tab").toBe(2);
  });
});
