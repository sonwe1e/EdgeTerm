import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { useStore } from "../store";
import type { SessionProfile } from "../types";
import {
  clippedTextIssues,
  focusRingContrastIssues,
  focusRingIssues,
  targetSizeIssues,
  textContrastIssues,
} from "../uiAudit";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The measured audit, pointed at the dialogs. The shell gate (uiAudit) reads
 * the chrome; this file reads the surfaces a reader only meets occasionally —
 * new session, display settings, keyboard shortcuts, about — and fails on the
 * same three properties: readable text, hittable controls, no clipped label.
 *
 * Boundary: Chromium over a controlled IPC stub; lazily loaded dialogs are
 * opened through the command palette, keyboard only.
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
      gpuRenderer: false,
      profiles: PROFILES,
      groups: [],
      tabs: [],
      panes: [{ id: "root", activeTabId: null }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      activeId: null,
      panels: { sessions: true, sender: false, filer: true },
      panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
      status: "Connected",
      error: null,
    },
    true,
  );
  // After the state reset: the setter publishes the language for both the
  // translator and `useT`, which the reset would otherwise put back.
  useStore.getState().setLanguage("en");
};

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const openDialog = async (query: string) => {
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
  // The palette is itself a dialog: wait for it to be gone *and* for the
  // command's dialog to be open, or the audit would grade the wrong surface.
  await until(
    () =>
      document.querySelector(".command-palette-input") === null &&
      document.querySelector("dialog[open]") !== null,
  );
  await twoFrames();
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  expect(dialog, "the " + query + " dialog is open").not.toBeNull();
  return dialog!;
};

/** Opens a dialog from the menu bar, the way a mouse user reaches Settings. */
const openFromMenu = async (menu: string, entry: string) => {
  const titles = Array.from(document.querySelectorAll<HTMLElement>("[id^='menu-title-']"));
  const title = titles.find((button) => button.textContent?.trim() === menu);
  expect(
    titles.map((node) => node.textContent?.trim()),
    menu + " menu",
  ).toContain(menu);
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

const closeTopDialog = async () => {
  await userEvent.keyboard("{Escape}");
  await until(() => document.querySelector("dialog[open]") === null);
  await twoFrames();
};

const describeIssue = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

/** Freezes transitions so the sweep never samples a half-faded ring. */
const withMotionFrozen = async <T>(run: () => T): Promise<T> => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  try {
    return run();
  } finally {
    style.remove();
  }
};

const audit = (dialog: HTMLElement, label: string) => {
  const contrast = textContrastIssues(dialog);
  const targets = targetSizeIssues(dialog);
  const clips = clippedTextIssues(dialog);
  expect(contrast.issues.map(describeIssue), label + " contrast").toEqual([]);
  expect(targets.issues.map(describeIssue), label + " targets").toEqual([]);
  expect(clips.issues.map(describeIssue), label + " clipped labels").toEqual([]);
  // An empty list is only meaningful if the collectors saw the dialog.
  expect(contrast.inspected + contrast.indeterminate, label + " text inspected").toBeGreaterThan(2);
  // About is a small dialog: one filled button plus its links.
  expect(targets.inspected, label + " targets inspected").toBeGreaterThan(0);
};

describe("dialog audit", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  for (const [label, command] of [
    ["new session", "New Session"],
    ["display settings", "Display Settings"],
    ["keyboard shortcuts", "Keyboard Shortcuts"],
    ["about", "About EdgeTerm"],
  ] as const) {
    it("keeps the " + label + " dialog readable and hittable", async () => {
      await page.viewport(1280, 800);
      applyFixture();
      mount(h(StrictMode, null, h(App)));
      await twoFrames();
      await twoFrames();
      const dialog = await openDialog(command);
      audit(dialog, label);
      await closeTopDialog();
    });
  }
  it("keeps the settings dialog readable and hittable", async () => {
    await page.viewport(1280, 800);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    const dialog = await openFromMenu("View", "Settings");
    audit(dialog, "settings");
    await closeTopDialog();
  });

  it("fits the new session dialog on a small laptop", async () => {
    await page.viewport(720, 560);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    const dialog = await openDialog("New Session");
    const box = dialog.getBoundingClientRect();
    expect(box.right, "dialog stays inside the viewport").toBeLessThanOrEqual(720);
    expect(box.left).toBeGreaterThanOrEqual(0);
    audit(dialog, "new session at 720x560");
    await closeTopDialog();
  });

  it("keeps the settings dialog usable at a laptop size, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page.viewport(900, 560);
      applyFixture();
      useStore.getState().setTheme(theme);
      mount(h(StrictMode, null, h(App)));
      await twoFrames();
      await twoFrames();
      const dialog = await openFromMenu("View", "Settings");
      // The modal focuses itself when it opens; measuring before that point
      // samples a dialog that is still fading in (the first full-suite run
      // failed exactly once this way).
      await until(() => dialog.contains(document.activeElement));
      const box = dialog.getBoundingClientRect();
      expect(box.top, theme + " dialog stays inside the viewport").toBeGreaterThanOrEqual(0);
      expect(box.bottom, theme + " dialog stays inside the viewport").toBeLessThanOrEqual(560);
      // One real Tab first: Chromium only lets a scripted focus inherit
      // :focus-visible once keyboard modality exists (see focusRingIssues).
      await userEvent.keyboard("{Tab}");
      await twoFrames();
      // Measure with motion frozen: a ring sampled mid-fade reads as absent.
      await withMotionFrozen(() => {
        audit(dialog, "settings at 900x560 " + theme);
      });
      const sweep = await withMotionFrozen(() => focusRingIssues(dialog));
      expect(sweep.inspected, theme + " focus stops").toBeGreaterThan(8);
      expect(sweep.issues.map(describeIssue), theme + " focus rings").toEqual([]);
      const rings = await withMotionFrozen(() => focusRingContrastIssues(dialog));
      expect(rings.inspected, theme + " ring colours").toBeGreaterThan(0);
      expect(rings.issues.map(describeIssue), theme + " ring contrast").toEqual([]);
      await closeTopDialog();
    }
  });

  it("gives the shortcuts sheet real focus rings on every stop", async () => {
    await page.viewport(900, 560);
    applyFixture();
    mount(h(StrictMode, null, h(App)));
    await twoFrames();
    await twoFrames();
    const dialog = await openDialog("Keyboard Shortcuts");
    await until(() => dialog.contains(document.activeElement));
    await userEvent.keyboard("{Tab}");
    await twoFrames();
    const sweep = await withMotionFrozen(() => focusRingIssues(dialog));
    expect(sweep.inspected, "focus stops in the shortcuts sheet").toBeGreaterThan(8);
    expect(sweep.issues.map(describeIssue), "shortcuts focus rings").toEqual([]);
    const rings = await withMotionFrozen(() => focusRingContrastIssues(dialog));
    expect(rings.issues.map(describeIssue), "shortcuts ring contrast").toEqual([]);
    await closeTopDialog();
  });
});
