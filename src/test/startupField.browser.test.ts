import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { SessionDialog } from "../components/SessionDialog";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * A brand-new connection can carry its first command: the field is part of
 * the form, the command is filed under the id Save or Connect hands back, and
 * the shell receives it once connected.
 */

const WRITES: { id: string; data: string }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "save_profile") {
      const profile = args.profile as Record<string, unknown>;
      return { ...profile, id: "p-new" };
    }
    if (command === "open_session") {
      const profile = args.profile as { name: string; kind: string; host?: string };
      return {
        status: "connected",
        info: {
          id: String(args.sessionId),
          name: profile.name,
          kind: profile.kind,
          protocol: profile.kind,
          profileId: "p-new",
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
      WRITES.push({ id: String(args.sessionId), data: String(args.data) });
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

const setValue = (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const field = (name: string) =>
  document.querySelector<HTMLInputElement>('[data-field="' + name + '"]')!;

describe("a new connection and its first command", () => {
  beforeEach(() => {
    localStorage.clear();
    WRITES.length = 0;
    useStore.setState({
      ...initial,
      startupCommands: {},
      profiles: [],
      groups: [],
      tabs: [],
      activeId: null,
      panes: [{ id: "root", activeTabId: null }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
    });
    useStore.getState().setLanguage("en");
  });

  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  it("files the command under the saved id and runs it on connect", async () => {
    await page.viewport(1440, 900);
    mount(
      h(SessionDialog, {
        initial: null,
        onClose: () => {},
        onSaved: () => {},
      }),
    );
    await twoFrames();

    const startup = document.querySelector<HTMLInputElement>("#session-startup");
    expect(startup, "a brand-new connection offers the field").not.toBeNull();
    setValue(field("name"), "build box");
    setValue(field("host"), "box.internal");
    // The username field has no data-field hook; its placeholder is stable.
    setValue(document.querySelector<HTMLInputElement>('input[placeholder="user"]')!, "deploy");
    setValue(startup!, "cd /srv/app");
    await twoFrames();
    expect(useStore.getState().startupCommands, "typing alone does not persist").toEqual({});

    // New SSH profile: the primary footer button is "Save & connect".
    const connect = document.querySelector<HTMLButtonElement>(".dialog-footer .btn.is-primary");
    expect(connect, "the connect button").not.toBeNull();
    await userEvent.click(connect!);
    await until(() => useStore.getState().startupCommands["p-new"] === "cd /srv/app");
    expect(useStore.getState().startupCommands).toEqual({ "p-new": "cd /srv/app" });

    await until(() => WRITES.some((write) => write.data === "cd /srv/app\r"));
    expect(WRITES.some((write) => write.data === "cd /srv/app\r")).toBe(true);
  });
});
