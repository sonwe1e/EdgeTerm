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

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("display settings numeric editing", () => {
  it("allows clearing and typing a multi-digit font size without clamping each keystroke", () => {
    mount();
    const input = host.querySelector<HTMLInputElement>(".font-size-number")!;
    inputValue(input, "");
    expect(input.value).toBe("");
    inputValue(input, "1");
    expect(input.value).toBe("1");
    inputValue(input, "14");
    apply();
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ panelFontSize: 14 }));
  });

  it("stages scrollback text and normalizes only on blur or Apply", () => {
    mount();
    const input = host.querySelector<HTMLInputElement>(".scrollback-number")!;
    inputValue(input, "2");
    expect(input.value).toBe("2");
    inputValue(input, "25000");
    apply();
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ terminalScrollback: 25000 }));
  });

  it("keeps applied values bounded and restores the initial value for an empty field", () => {
    mount();
    const inputs = host.querySelectorAll<HTMLInputElement>(".font-size-number");
    inputValue(inputs[0], "999");
    inputValue(inputs[1], "");
    apply();
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ panelFontSize: 18, bufferFontSize: 13 }),
    );
  });

  it("normalizes on blur and keeps the range control in sync", () => {
    mount();
    const input = host.querySelector<HTMLInputElement>(".font-size-number")!;
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => input.focus());
    inputValue(input, "1");
    expect(input.value).toBe("1");
    act(() => input.blur());
    expect(input.value).toBe("10");
    expect(slider.value).toBe("10");
    inputValue(slider, "16");
    expect(input.value).toBe("16");
    apply();
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ panelFontSize: 16 }));
  });
});
