import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { openSession } from "../actions";
import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The startup command a profile runs by itself once the shell is up: the
 * connection reports connected, a short wait lets the prompt print, then the
 * line is written. File sessions have no prompt to type into and never run it.
 */

const WRITES: { id: string; data: string }[] = [];
/** Set to make the next write fail, the way a dead broker would. */
let writeFails = false;
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "open_session") {
      const profile = args.profile as { id: string; name: string; kind: string; host?: string };
      return {
        status: "connected",
        info: {
          id: String(args.sessionId),
          name: profile.name,
          kind: profile.kind,
          protocol: profile.kind,
          profileId: profile.id,
          address: profile.host ?? profile.name,
          color: null,
          supportsRemoteFiles: false,
          recording: null,
          legacyAlgorithms: [],
          sharedConnection: false,
        },
      };
    }
    if (command === "write_session") {
      if (writeFails) throw new Error("broker gone");
      WRITES.push({ id: String(args.id), data: String(args.data) });
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

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(30);
};

const freshWindow = async () => {
  await page.viewport(1440, 900);
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.getState().setLanguage("en");
  useStore.setState({
    tabs: [],
    activeId: null,
    panes: [{ id: "root", activeTabId: null }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
  });
  mount(h(App));
  await twoFrames();
};

describe("the command a profile runs after connecting", () => {
  beforeEach(() => {
    localStorage.clear();
    WRITES.length = 0;
    useStore.setState({ ...initial, startupCommands: {} });
  });

  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  it("types the stored command once the shell is connected", async () => {
    await freshWindow();
    useStore.getState().setStartupCommand("p1", "cd /srv/app");

    await openSession({
      id: "p1",
      name: "box",
      kind: "ssh",
      host: "box.internal",
      username: "ops",
    });
    await until(() => WRITES.some((write) => write.data === "cd /srv/app\r"));
    expect(WRITES).toContainEqual({ id: expect.any(String), data: "cd /srv/app\r" });
  });

  it("says so when the stored line cannot reach the shell", async () => {
    await freshWindow();
    useStore.getState().setStartupCommand("p9", "cd /srv/app");
    writeFails = true;
    try {
      await openSession({
        id: "p9",
        name: "box",
        kind: "ssh",
        host: "box.internal",
        username: "ops",
      });
      await until(() => useStore.getState().status.startsWith("Startup command could not be sent"));
      expect(useStore.getState().status).toContain("broker gone");
    } finally {
      writeFails = false;
    }
  });

  it("never types it into a file session", async () => {
    await freshWindow();
    useStore.getState().setStartupCommand("p2", "cd /srv/app");

    await openSession({ id: "p2", name: "files", kind: "sftp", host: "box.internal" });
    await wait(900);
    expect(WRITES.filter((write) => write.data === "cd /srv/app\r")).toEqual([]);
  });
});
