import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { translate } from "../i18n";
import { useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * Live terminal zoom: Ctrl+= / Ctrl+- / Ctrl+0. The store clamps and persists,
 * the app republishes the size as a CSS variable, and the rendered cell grows
 * or shrinks with it — the three things that make the chord feel wired.
 *
 * Boundary: Chromium over a controlled IPC stub, one session.
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
const ID = "zoom-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "zoom",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-zoom",
    address: "zoom.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-zoom", name: "zoom", kind: "ssh", host: "zoom.internal", username: "deploy" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

// The status bar is the one place a refusal can be reported from, and every
// surface that runs a command - the chord, the menu, the palette - reads it.
const statusText = () => useStore.getState().status;
const expected = (key: "status.noActiveSession" | "status.noTerminal") =>
  translate(useStore.getState().language, key);

/**
 * A command that needs a session to act on. The palette row, the menu entry
 * and the chord all reach one dispatcher, and until now a refusal looked
 * exactly like success: the row closed, nothing happened, nothing said why.
 *
 * Boundary: Chromium over a controlled IPC stub, no session mounted.
 */
describe("a shortcut that has nothing to act on", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  // A file session: the state the second half of the defect lives in. Both
  // refusals are driven from here because the chords that need a session at
  // all are the ones the browser is entitled to answer first.
  const mountFileSession = async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    const file = tab();
    file.info = { ...file.info, id: "file-session", kind: "sftp", name: "files" };
    useStore.setState({
      ...initial,
      tabs: [file],
      activeId: "file-session",
      panes: [{ id: "root", activeTabId: "file-session" }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
  };

  it("names the missing terminal when the session has none", async () => {
    await mountFileSession();
    // Alt+K clears, and clearing needs a terminal: an SFTP tab has a
    // dual-pane browser instead.
    await userEvent.keyboard("{Alt>}k{/Alt}");
    await twoFrames();
    expect(statusText()).toBe(expected("status.noTerminal"));
  });

  it("names the missing session when there is none at all", async () => {
    await mountFileSession();
    // Close the file session, then act again: the chord the reference
    // advertises now has nothing to act on.
    await act(async () => {
      useStore.setState({ tabs: [], activeId: null });
    });
    await twoFrames();
    await userEvent.keyboard("{Alt>}k{/Alt}");
    await twoFrames();
    expect(statusText()).toBe(expected("status.noActiveSession"));
  });
});
