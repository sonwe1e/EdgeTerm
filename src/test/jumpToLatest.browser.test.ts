import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The "jump to latest" pill: absent at the live end, present once the viewport
 * is above it, and one click returns to the bottom and puts it away. It must
 * also be a real target, not a hairline.
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
const ID = "jump-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "jump",
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-jump",
    address: "jump.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-jump", name: "jump", kind: "ssh", host: "jump.internal", username: "deploy" },
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

const pill = () => document.querySelector<HTMLButtonElement>(".term-jump-latest");

describe("jump to latest output", () => {
  afterEach(async () => {
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
  });

  it("appears above the live end, jumps back, and is a real target", async () => {
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
    for (let index = 0; index < 2; index += 1) {
      controller.term.write(
        Array.from({ length: 120 }, (_, line) => `line ${index * 120 + line}`).join("\r\n") +
          "\r\n",
      );
    }
    await twoFrames();
    expect(pill(), "nothing to jump at the live end").toBeNull();

    controller.term.scrollLines(-40);
    await until(() => pill() !== null);
    expect(controller.term.buffer.active.viewportY).toBeLessThan(
      controller.term.buffer.active.baseY,
    );
    const button = pill()!;
    const box = button.getBoundingClientRect();
    expect(box.height, "the pill is a real target").toBeGreaterThanOrEqual(24);
    expect(button.getAttribute("aria-label")).toBe("Jump to latest output");
    expect(
      box.right <= window.innerWidth + 1 && box.left >= -1,
      "the pill stays inside the pane",
    ).toBe(true);

    await userEvent.click(button);
    await twoFrames();
    expect(controller.term.buffer.active.viewportY, "the viewport returned to the newest row").toBe(
      controller.term.buffer.active.baseY,
    );
    expect(pill(), "the pill goes away at the live end").toBeNull();
  });
});
