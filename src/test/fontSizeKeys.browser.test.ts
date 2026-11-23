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

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const sizeVar = () =>
  getComputedStyle(document.querySelector(".app")!).getPropertyValue("--buffer-font-size").trim();

const rowHeight = () =>
  document.querySelector<HTMLElement>(".xterm-rows")!.getBoundingClientRect().height;

const press = async (code: string) => {
  await userEvent.keyboard(`{Control>}${code}{/Control}`);
  await twoFrames();
};

describe("terminal font size chords", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("zooms the terminal in, out and back to the default, and persists it", async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      bufferFontSize: 14,
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
    await twoFrames();
    getController(ID)!.focus();
    await twoFrames();
    expect(sizeVar(), "the app publishes the size").toBe("14px");
    const before = rowHeight();

    await press("=");
    await press("=");
    expect(useStore.getState().bufferFontSize).toBe(16);
    expect(localStorage.getItem("edgeterm.bufferFontSize")).toBe("16");
    expect(sizeVar()).toBe("16px");
    expect(useStore.getState().status).toBe("Terminal font 16px");
    expect(rowHeight(), "the rendered rows grew with the font").toBeGreaterThan(before);

    await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
    await twoFrames();
    expect(useStore.getState().bufferFontSize).toBe(14);
    expect(localStorage.getItem("edgeterm.bufferFontSize")).toBe("14");
    expect(sizeVar()).toBe("14px");

    await press("-");
    expect(useStore.getState().bufferFontSize).toBe(13);
    expect(sizeVar()).toBe("13px");

    // The floor holds: the chord reports the clamped size, not the request.
    useStore.getState().setBufferFontSize(8);
    await until(() => useStore.getState().bufferFontSize === 8);
    await press("-");
    expect(useStore.getState().bufferFontSize).toBe(8);
    expect(useStore.getState().status).toBe("Terminal font 8px");
  });

  it("zooms with Ctrl+wheel and leaves a plain wheel alone", async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab()],
      activeId: ID,
      panes: [{ id: "root", activeTabId: ID }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      bufferFontSize: 14,
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
    await twoFrames();
    const element = getController(ID)!.term.element!;

    const plain = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    element.dispatchEvent(plain);
    await twoFrames();
    expect(useStore.getState().bufferFontSize, "a plain wheel scrolls").toBe(14);
    expect(plain.defaultPrevented, "scrolling is not claimed").toBe(false);

    const zoomIn = new WheelEvent("wheel", {
      deltaY: -120,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(zoomIn);
    await twoFrames();
    expect(useStore.getState().bufferFontSize).toBe(15);
    expect(zoomIn.defaultPrevented, "the page must not zoom instead").toBe(true);
    expect(sizeVar()).toBe("15px");

    for (const delta of [120, 120]) {
      element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true }),
      );
    }
    await twoFrames();
    expect(useStore.getState().bufferFontSize).toBe(13);
    expect(useStore.getState().status).toBe("Terminal font 13px");
  });
});
