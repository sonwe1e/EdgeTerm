import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { resetLatency } from "../inputLatency";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The typing-latency chip: a keystroke goes out, output comes back, and the bar
 * reports the gap. Only the real path counts — the keystroke must leave through
 * the input funnel and the answer must arrive through the terminal's write
 * path, which is exactly what a shell does.
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
const ID = "latency-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "latency",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-latency",
    address: "latency.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: {
    id: "p-latency",
    name: "latency",
    kind: "ssh",
    host: "latency.internal",
    username: "ops",
  },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const latencyText = () =>
  document.querySelector<HTMLElement>(".status-latency")?.textContent?.trim() ?? "";

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(20);
};

describe("typing latency", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLatency();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    resetLatency();
    useStore.setState(initial, true);
  });

  it("shows the gap between a keystroke and the echo that answers it", async () => {
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

    // Nothing has been typed, so there is nothing to report.
    expect(latencyText(), "no chip before any round trip").toBe("");

    controller.focus();
    await twoFrames();
    await userEvent.keyboard("a");
    // The stub records the write but sends nothing back: still no reading.
    expect(latencyText(), "a keystroke with no answer is not a measurement").toBe("");

    await wait(30);
    const encoder = new TextEncoder();
    await new Promise<void>((resolve) => controller.write(encoder.encode("a"), resolve));
    await until(() => latencyText().length > 0);
    expect(latencyText(), "the chip reports a duration").toMatch(/^\d+ ms$/);
  });
});
