import { afterEach, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));

import {
  defaultShortcuts,
  matchAppShortcut,
  parseShortcuts,
  setActiveShortcuts,
  shortcutOverrides,
} from "./shortcuts";

const press = (code: string, modifiers: Partial<KeyboardEvent>) => ({
  key: code,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

afterEach(() => setActiveShortcuts(defaultShortcuts()));

it("defaults to Ctrl+Tab in both directions and retains Alt+bracket navigation", () => {
  expect(matchAppShortcut(press("Tab", { ctrlKey: true }))).toEqual({ kind: "tabStep", step: 1 });
  expect(matchAppShortcut(press("Tab", { ctrlKey: true, shiftKey: true }))).toEqual({
    kind: "tabStep",
    step: -1,
  });
  expect(matchAppShortcut(press("BracketRight", { altKey: true }))).toEqual({
    kind: "tabStep",
    step: 1,
  });
  expect(matchAppShortcut(press("BracketLeft", { altKey: true }))).toEqual({
    kind: "tabStep",
    step: -1,
  });
  expect(matchAppShortcut(press("Tab", {}))).toBeNull();
  expect(matchAppShortcut(press("Tab", { shiftKey: true }))).toBeNull();
  expect(matchAppShortcut(press("Tab", { ctrlKey: true, altKey: true }))).toBeNull();
});

it("keeps explicit rebinding and unassignment authoritative over the legacy aliases", () => {
  const bindings = defaultShortcuts();
  bindings.nextTab = null;
  bindings.prevTab = { ctrl: true, alt: false, shift: true, meta: false, code: "PageUp" };
  setActiveShortcuts(bindings);
  expect(matchAppShortcut(press("Tab", { ctrlKey: true }))).toBeNull();
  expect(matchAppShortcut(press("Tab", { ctrlKey: true, shiftKey: true }))).toBeNull();
  expect(matchAppShortcut(press("BracketRight", { altKey: true }))).toBeNull();
  expect(matchAppShortcut(press("BracketLeft", { altKey: true }))).toBeNull();
  expect(matchAppShortcut(press("PageUp", { ctrlKey: true, shiftKey: true }))).toEqual({
    kind: "tabStep",
    step: -1,
  });
});

it("prefers an explicitly assigned command over a legacy tab alias", () => {
  const bindings = defaultShortcuts();
  bindings.find = { ctrl: false, alt: true, shift: false, meta: false, code: "BracketRight" };
  setActiveShortcuts(bindings);
  expect(matchAppShortcut(press("BracketRight", { altKey: true }))).toEqual({ kind: "find" });
});

it("loads old default overrides into the new scheme and round-trips customized tabs", () => {
  const defaults = defaultShortcuts();
  expect(parseShortcuts({}, defaults)?.nextTab).toEqual({
    ctrl: true,
    alt: false,
    shift: false,
    meta: false,
    code: "Tab",
  });
  const bindings = {
    ...defaults,
    nextTab: { ctrl: false, alt: true, shift: false, meta: false, code: "BracketRight" },
  };
  expect(parseShortcuts(shortcutOverrides(bindings), defaults)).toEqual(bindings);
});
