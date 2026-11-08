import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ listSystemFonts: vi.fn(async () => []) }));
vi.mock("../fonts", () => ({
  fontChoices: () => [],
  fontStack: () => "monospace",
  installedFonts: () => [],
  symbolFallbacks: () => [],
}));

import { TERMINAL_COLD_HISTORY_KEY, terminalColdHistoryEnabled } from "../storePreferences";
import { useStore } from "../store";
import { FontSizeDialog } from "./FontSizeDialog";

let host: HTMLDivElement;
let root: Root;

const onApply = vi.fn();
const onClose = vi.fn();

function mount() {
  act(() => {
    root.render(
      h(FontSizeDialog, {
        panelFontSize: 13,
        bufferFontSize: 13,
        panelFontFamily: "",
        bufferFontFamily: "",
        terminalScrollback: 10_000,
        cursorStyle: "block",
        cursorBlink: true,
        gpuRenderer: true,
        onApply,
        onClose,
      }),
    );
  });
}

function coldSwitch(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(".cold-history-setting input[type=checkbox]");
  if (!input) throw new Error("cold history switch is missing");
  return input;
}

function clickButton(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`missing ${text} button`);
  act(() => button.click());
}

function reopen() {
  act(() => root.unmount());
  root = createRoot(host);
  mount();
}

function apply() {
  act(() =>
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.clearAllMocks();
  useStore.setState({ language: "en" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("display settings cold history opt-in", () => {
  it("does not persist an experimental opt-in when Cancel is pressed", () => {
    mount();
    expect(coldSwitch().checked).toBe(false);
    act(() => coldSwitch().click());
    expect(coldSwitch().checked).toBe(true);
    expect(terminalColdHistoryEnabled()).toBe(false);

    clickButton("Cancel");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TERMINAL_COLD_HISTORY_KEY)).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("preserves an existing opt-in on Cancel and commits disabling on Apply", () => {
    localStorage.setItem(TERMINAL_COLD_HISTORY_KEY, "1");
    mount();
    expect(coldSwitch().checked).toBe(true);
    act(() => coldSwitch().click());
    expect(coldSwitch().checked).toBe(false);
    expect(terminalColdHistoryEnabled()).toBe(true);

    apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TERMINAL_COLD_HISTORY_KEY)).toBe("0");
    expect(terminalColdHistoryEnabled()).toBe(false);
  });

  it("commits a new opt-in only on Apply and restores it on reopening", () => {
    mount();
    act(() => coldSwitch().click());
    expect(terminalColdHistoryEnabled()).toBe(false);
    apply();
    expect(terminalColdHistoryEnabled()).toBe(true);
    reopen();
    expect(coldSwitch().checked).toBe(true);
  });

  it("stages Reset Defaults until Apply, like the other display settings", () => {
    localStorage.setItem(TERMINAL_COLD_HISTORY_KEY, "1");
    mount();
    clickButton("Reset Defaults");
    expect(coldSwitch().checked).toBe(false);
    expect(terminalColdHistoryEnabled()).toBe(true);
    clickButton("Cancel");
    expect(terminalColdHistoryEnabled()).toBe(true);
  });

  it("commits Reset Defaults to OFF only after Apply and keeps it on reopening", () => {
    localStorage.setItem(TERMINAL_COLD_HISTORY_KEY, "1");
    mount();
    clickButton("Reset Defaults");
    expect(terminalColdHistoryEnabled()).toBe(true);
    apply();
    expect(terminalColdHistoryEnabled()).toBe(false);
    reopen();
    expect(coldSwitch().checked).toBe(false);
  });
});
