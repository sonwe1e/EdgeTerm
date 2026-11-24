import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { COMMAND_RECENTS_KEY } from "../persistKeys";
import { IS_MAC } from "../platform";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import { clippedTextIssues, targetSizeIssues, textContrastIssues } from "../uiAudit";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * The palette as the user meets it: a real key chord in the real App opens a
 * native modal, the field filters the catalogue built from the app's own
 * state, Enter runs the pointed command and Escape leaves. The new surface
 * also goes through the round's visual audit (contrast, hit targets, clipped
 * labels), so a palette that only "works" but cannot be read fails here.
 *
 * Boundary: synthetic CDP input in Chromium over a controlled IPC stub. Not
 * WebView2, not a real server.
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "list_profiles") return [PROFILE];
    if (command === "list_groups") return [];
    if (command.startsWith("list_")) return [];
    if (command === "plugin:event|listen") return ++serial;
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const PROFILE: SessionProfile = {
  id: "p-build",
  name: "Build server",
  kind: "ssh",
  host: "build.internal",
  username: "build",
  port: 22,
} as SessionProfile;

const initial = useStore.getState();

const applyFixture = () => {
  useStore.setState(
    {
      ...initial,
      language: "en",
      theme: "dark",
      gpuRenderer: false,
      panelFontSize: 12,
      bufferFontSize: 14,
      profiles: [PROFILE],
      groups: [],
      tabs: [
        {
          info: {
            id: "t-build",
            profileId: "p-build",
            name: "Build server",
            kind: "ssh",
            protocol: "ssh",
            address: "build@build.internal:22",
            color: null,
            supportsRemoteFiles: true,
            recording: null,
            legacyAlgorithms: [],
            sharedConnection: false,
          },
          profile: PROFILE,
          number: 1,
          ordinal: 0,
          state: "connected",
          commandActivity: "idle",
          activityKind: "command",
          paneId: "root",
        },
      ],
      panes: [{ id: "root", activeTabId: "t-build" }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      activeId: "t-build",
      panels: { sessions: true, sender: false, filer: true },
      panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
      status: "Connected",
      error: null,
    },
    true,
  );
};

/**
 * The palette chord through the runner's own keyboard: raw CDP input goes to the
 * outer page, while the test frame is where the app lives.
 */
const pressPaletteChord = async () => {
  await userEvent.keyboard(
    IS_MAC ? "{Meta>}{Shift>}P{/Shift}{/Meta}" : "{Control>}{Shift>}P{/Shift}{/Control}",
  );
  await twoFrames();
};

const palette = (): HTMLElement | null => document.querySelector<HTMLElement>(".command-palette");
/** The controlled dialog stays mounted when closed; its open flag is the truth. */
const paletteOpen = (): boolean =>
  document.querySelector(".command-palette")?.closest("dialog")?.open === true;
const input = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(".command-palette-input");
const options = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".command-palette [role='option']"));

const typeQuery = async (value: string) => {
  const field = input()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
};

const pressKey = async (key: string) => {
  input()!.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
  );
  await twoFrames();
};

describe("the command palette in the real app", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
  });

  it("finds a session by the port in its address", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    // After mount, because the app loads its profiles from the backend on start:
    // a value set before mounting is replaced by that load.
    useStore.setState({ profiles: [{ ...PROFILE, port: 2222 }] });
    await twoFrames();
    await pressPaletteChord();
    await typeQuery("2222");
    // Nothing else in this catalogue contains "2222": only the port in the
    // session's hint can bring the row back, and the row still names the
    // session rather than the number.
    const rows = options().map((row) => row.textContent ?? "");
    expect(rows.join(" | "), "the session on port 2222 is offered").toContain("Build server");
  });

  it("offers to connect to a host typed into the field, and connects on Enter", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await pressPaletteChord();

    // A phrase is a search: no connect row appears.
    await typeQuery("display");
    expect(options()[0].textContent).not.toContain("Connect to");

    await typeQuery("root@10.0.0.5:2222");
    const first = options()[0];
    expect(first.textContent, "the target is the first thing Enter would run").toContain(
      "Connect to root@10.0.0.5:2222",
    );
    // The row says which account and port the connection will use, so an
    // address typed without one is not a guess.
    expect(first.textContent, "the row names the resolved account").toContain(
      "SSH as root, port 2222",
    );

    await pressKey("Enter");
    await twoFrames();
    const tab = useStore.getState().tabs.find((item) => item.info.name === "root@10.0.0.5:2222");
    expect(tab, "a session opened for the typed target").toBeTruthy();
    expect(tab!.profile).toMatchObject({ host: "10.0.0.5", username: "root", port: 2222 });
    expect(paletteOpen(), "the palette closed on connect").toBe(false);

    // Second visit: the machine just reached is offered again. `10.0.` is not
    // a target (a host cannot end in a dot), so this row can only be the
    // remembered one.
    await pressPaletteChord();
    await typeQuery("10.0.");
    const remembered = options().find((item) =>
      item.textContent?.startsWith("Connect to root@10.0.0.5:2222"),
    );
    expect(remembered, "the recent target is offered").toBeTruthy();
    expect(remembered!.textContent, "and says where it came from").toContain("Connected recently");
  });

  it("opens from the real chord, is readable, and filters what is typed", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();

    await pressPaletteChord();
    const panel = palette();
    expect(panel, "the chord opens the palette").not.toBeNull();
    expect(paletteOpen(), "the palette is the open modal").toBe(true);
    expect(document.querySelector("dialog[open]")?.contains(panel)).toBe(true);
    expect(document.activeElement, "the field owns focus").toBe(input());
    expect(options().length, "the catalogue is not empty").toBeGreaterThan(20);

    // The new surface meets the same measured bar as the rest of the chrome.
    const contrast = textContrastIssues(panel!);
    const targets = targetSizeIssues(panel!);
    const clips = clippedTextIssues(panel!);
    expect(contrast.issues.map((issue) => issue.path + " " + issue.detail)).toEqual([]);
    expect(targets.issues.map((issue) => issue.path + " " + issue.detail)).toEqual([]);
    expect(clips.issues.map((issue) => issue.path + " " + issue.detail)).toEqual([]);
    expect(contrast.inspected, "text runs inspected").toBeGreaterThan(3);
    expect(targets.inspected, "targets inspected").toBeGreaterThan(3);

    // The same surface in all four palettes: a menu ink that clears 4.5:1 in
    // the dark half must not fall under it in serialX's warm canvases.
    for (const theme of ["light", "serialx-dark", "serialx-light"] as const) {
      useStore.setState({ theme });
      await twoFrames();
      const themed = textContrastIssues(palette()!);
      expect(
        themed.issues.map((issue) => theme + " " + issue.path + " " + issue.detail),
        theme,
      ).toEqual([]);
    }
    useStore.setState({ theme: "dark" });

    const before = options().length;
    await typeQuery("theme");
    expect(options().length).toBeLessThan(before);
    expect(options()[0].textContent?.toLowerCase()).toContain("theme");

    await typeQuery("zzzz");
    expect(options()).toHaveLength(0);
    expect(document.querySelector(".command-palette-empty")?.textContent).toContain("zzzz");
  });

  it("runs the pointed command with Enter, and Escape leaves without running one", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    useStore.setState({ theme: "dark" });
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();

    await pressPaletteChord();
    // An exact label ranks first, so the pointed row is deterministic.
    await typeQuery("Theme: Light");
    expect(options()[0].textContent).toContain("Theme: Light");
    await pressKey("Enter");
    await twoFrames();
    expect(paletteOpen(), "running a command closes the palette").toBe(false);
    expect(useStore.getState().theme, "the command really ran").toBe("light");
    const recents = JSON.parse(localStorage.getItem(COMMAND_RECENTS_KEY) ?? "[]") as string[];
    expect(recents[0]).toBe("theme:light");

    // A second visit, abandoned: no command runs and the modal is gone.
    useStore.setState({ theme: "dark" });
    await pressPaletteChord();
    expect(paletteOpen()).toBe(true);
    await pressKey("Escape");
    await twoFrames();
    expect(paletteOpen()).toBe(false);
    expect(useStore.getState().theme).toBe("dark");
  });
});

it("does not show a blank account for a host typed without one", async () => {
  mount(h(StrictMode, null, h(App)));
  await twoFrames();
  await pressPaletteChord();
  await typeQuery("example.com");
  const first = options()[0];
  expect(first.textContent, "the target is offered").toContain("Connect to example.com");
  // No account was typed, so there is none to name: an "SSH as , port 22"
  // sentence would read as a gap where the user's own name should be.
  expect(first.textContent, "an untyped account is not a gap").not.toContain("SSH as ,");
  expect(first.textContent, "the row still says what it does").toContain("without saving");
});
