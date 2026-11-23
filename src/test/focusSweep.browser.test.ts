import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import { focusRingContrastIssues, focusRingIssues } from "../uiAudit";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * Keyboard sweep: every focus stop in the mounted UI must look different after
 * focus. A control whose computed style does not change when focused is
 * invisible to a keyboard user even if some stylesheet declares
 * `:focus-visible` for a different selector.
 *
 * Boundary: Chromium over a controlled IPC stub. Programmatic focus is made
 * honest by sending one real Tab first (Chromium then lets scripted focus
 * inherit :focus-visible), by freezing transitions (a ring fades in over
 * 80-120ms and a synchronous snapshot would read an intermediate value), and by
 * grading only elements that really took focus (a roving-tabindex row or a
 * hidden input is not a focus stop).
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "list_profiles") return PROFILES;
    if (command === "list_groups") return [];
    if (command.startsWith("list_")) return [];
    if (command === "plugin:event|listen") return ++serial;
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const PROFILES: SessionProfile[] = [
  { id: "p-build", name: "Build server", kind: "ssh", host: "build.internal", username: "build" },
  { id: "p-local", name: "PowerShell", kind: "local", shell: "pwsh.exe" },
] as SessionProfile[];

const initial = useStore.getState();

const applyFixture = () => {
  useStore.setState(
    {
      ...initial,
      language: "en",
      theme: "dark",
      gpuRenderer: false,
      profiles: PROFILES,
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
          profile: PROFILES[0],
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
 * A splitter is a documentation-approved exception: its focus ring is the 4px
 * accent line on ::before (status.styles.css), which the collector cannot read
 * from the host element's computed style.
 */
const IGNORE = ".splitter";

const describeIssue = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

/**
 * Focus indicators are often transitioned, so a snapshot taken synchronously
 * after focus would compare two intermediate values. Freezing the transitions
 * does not change what is graded: a focus ring is not a motion effect.
 */
const withMotionFrozen = async <T>(run: () => T): Promise<T> => {
  const style = document.createElement("style");
  style.textContent =
    "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.append(style);
  try {
    return run();
  } finally {
    style.remove();
  }
};

/** Waits for a lazy dialog's chunk to arrive; the bundle is split. */
const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

/** Opens a command through the palette, keyboard only. */
const runPaletteCommand = async (query: string) => {
  await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
  await twoFrames();
  const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, query);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
  );
  await twoFrames();
};

/** Opens an entry from the menu bar, the mouse path to Settings. */
const openFromMenu = async (menu: string, entry: string) => {
  const title = Array.from(document.querySelectorAll<HTMLElement>("[id^='menu-title-']")).find(
    (node) => node.textContent?.trim() === menu,
  );
  expect(title, menu + " menu").toBeTruthy();
  await userEvent.click(title!);
  await twoFrames();
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (node) => node.textContent?.trim().startsWith(entry),
  );
  expect(item, entry + " entry").toBeTruthy();
  await userEvent.click(item!);
  await until(() => document.querySelector("dialog[open]") !== null);
  await twoFrames();
  return document.querySelector<HTMLDialogElement>("dialog[open]")!;
};

const sweepFocusStops = async (root: ParentNode, label: string, floor: number) => {
  // Keyboard modality: Chromium lets scripted focus inherit :focus-visible
  // only after a real key event moved focus.
  await userEvent.keyboard("{Tab}");
  await twoFrames();
  const sweep = await withMotionFrozen(() => focusRingIssues(root, { ignore: IGNORE }));
  expect(sweep.inspected, label + " controls inspected").toBeGreaterThan(floor);
  expect(sweep.issues.map(describeIssue), label + " focus stops").toEqual([]);
  // Presence is not visibility: the ring's own colour must clear 3:1 against
  // the surface it sits on (WCAG 1.4.11). Indicators that are not outlines are
  // counted separately, never silently passed.
  const rings = await withMotionFrozen(() => focusRingContrastIssues(root, { ignore: IGNORE }));
  expect(rings.inspected, label + " ring colours measured").toBeGreaterThan(0);
  expect(rings.issues.map(describeIssue), label + " ring contrast").toEqual([]);
};

describe("keyboard focus sweep", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
  });

  it("gives every focus stop in the shell a visible change", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    // The SSH reuse checkbox lives in a closed disclosure: open it so the
    // sweep grades the checkbox itself rather than a hidden control.
    const disclosure = document.querySelector<HTMLDetailsElement>(".ssh-connection-options");
    expect(disclosure, "SSH reuse disclosure").not.toBeNull();
    disclosure!.open = true;
    await twoFrames();
    await sweepFocusStops(document.body, "shell", 15);
  });

  it("gives every focus stop in the new-session dialog a visible change", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await runPaletteCommand("New Session");
    await until(() => document.querySelector("dialog[open]") !== null);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    await sweepFocusStops(dialog, "session dialog", 8);
  });

  it("gives every focus stop in the display settings dialog a visible change", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await runPaletteCommand("Display Settings");
    await until(() => document.querySelector("dialog[open]") !== null);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    await sweepFocusStops(dialog, "display settings", 5);
  });

  it("would report a focus stop whose indicator is removed", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    // The same tree the sweep just passed, with one drop-down's focus state
    // taken away: a collector that still says "clean" would be vacuous.
    const strip = document.createElement("style");
    strip.textContent =
      ".menu-item:focus-visible { background: none !important; outline: none !important; }";
    document.head.append(strip);
    try {
      await userEvent.keyboard("{Tab}");
      await twoFrames();
      const sweep = await withMotionFrozen(() =>
        focusRingIssues(document.body, { ignore: IGNORE }),
      );
      expect(
        sweep.issues.map(describeIssue).some((line) => line.includes("button.menu-item")),
        "the stripped control is reported",
      ).toBe(true);
    } finally {
      strip.remove();
    }
  });

  it("would report the checkbox if its ring rule were neutralised", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    const disclosure = document.querySelector<HTMLDetailsElement>(".ssh-connection-options")!;
    disclosure.open = true;
    await twoFrames();
    const strip = document.createElement("style");
    strip.textContent =
      'input[type="checkbox"]:focus, input[type="checkbox"]:focus-visible { outline: none !important; box-shadow: none !important; border-color: var(--border) !important; }';
    document.head.append(strip);
    try {
      await userEvent.keyboard("{Tab}");
      await twoFrames();
      const sweep = await withMotionFrozen(() =>
        focusRingIssues(document.body, { ignore: IGNORE }),
      );
      expect(
        sweep.issues.map(describeIssue).some((line) => line.includes("Automatically reuse")),
        "the neutralised checkbox is reported",
      ).toBe(true);
    } finally {
      strip.remove();
    }
  });

  it("gives every focus stop in the settings dialog a visible, perceivable ring", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    const dialog = await openFromMenu("View", "Settings");
    await sweepFocusStops(dialog, "settings dialog", 12);
  });

  it("gives every focus stop in the shortcuts dialog a visible, perceivable ring", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await runPaletteCommand("Keyboard Shortcuts");
    await until(
      () =>
        document.querySelector(".command-palette-input") === null &&
        document.querySelector("dialog[open]") !== null,
    );
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    await sweepFocusStops(dialog, "shortcuts dialog", 10);
  });

  it("would report a ring drawn in the surface colour", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    await runPaletteCommand("Display Settings");
    await until(() => document.querySelector("dialog[open]") !== null);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    const strip = document.createElement("style");
    // A ring that exists but matches the dialog surface: the change-based
    // sweep passes it, and only the colour measurement can fail it.
    strip.textContent =
      "dialog[open] button:focus-visible { outline-color: var(--bg-menu) !important; }";
    document.head.append(strip);
    try {
      await userEvent.keyboard("{Tab}");
      await twoFrames();
      const rings = await withMotionFrozen(() =>
        focusRingContrastIssues(dialog, { ignore: IGNORE }),
      );
      expect(rings.issues.length, "a ring the colour of its surface is reported").toBeGreaterThan(
        0,
      );
    } finally {
      strip.remove();
    }
  });
});
