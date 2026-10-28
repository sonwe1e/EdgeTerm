import { afterEach, expect, it, vi } from "vitest";
import { TerminalController } from "../terminal";
import { isWebglEnabled, setWebglEnabled } from "../terminalRegistry";
import "../styles.css";
import { twoFrames, wait } from "./browserHarness";

// Real xterm/WebGL and layout. Evicting a hidden GPU holder must not paint
// DOM rows into a display:none host: xterm 6 cannot cache zero-width glyphs
// there. This is a behavior gate, not a portable timing benchmark. Native
// WebView2 and PTY measurements live in the defect-fix acceptance record.
const live: { controller: TerminalController; slot: HTMLElement }[] = [];
let previousWebgl = true;

afterEach(() => {
  for (const { controller, slot } of live.splice(0)) {
    controller.dispose();
    slot.remove();
  }
  setWebglEnabled(previousWebgl);
});

it("does not paint an evicted terminal while hidden and preserves it on return", async () => {
  previousWebgl = isWebglEnabled();
  setWebglEnabled(true);
  const make = () => {
    const slot = document.createElement("div");
    slot.className = "pane-slot";
    slot.style.cssText = "position:absolute;left:0;top:0;width:900px;height:480px";
    const host = document.createElement("div");
    host.className = "term-pane";
    slot.append(host);
    document.body.append(slot);
    const controller = new TerminalController(
      `gpu-eviction-${live.length}`,
      {
        onData() {},
        onResize() {},
        onStatus() {},
        onCommand() {},
        onCommandState() {},
        suggest: () => [],
        forgetSuggestion() {},
      },
      14,
      10000,
    );
    live.push({ controller, slot });
    controller.attach(host);
    controller.setVisible(true);
    controller.fit(true);
    return { controller, slot };
  };
  const first = make();
  await new Promise<void>((resolve) =>
    first.controller.term.write(
      Array.from(
        { length: 1000 },
        (_, index) =>
          `eviction-${index} 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ` +
          (index === 999 ? " 中文 \x1b[1mB\x1b[3mC\x1b[22mD\x1b[0m" : ""),
      ).join("\r\n"),
      resolve,
    ),
  );
  first.controller.term.select(0, 999, 12);
  const selection = first.controller.term.getSelection();
  await twoFrames();
  expect(first.slot.querySelector(".xterm-screen > canvas")).not.toBeNull();
  first.slot.classList.add("is-hidden");
  first.controller.setVisible(false);
  await twoFrames();

  // Six more holders cross the production limit of six; each old slot is
  // hidden exactly as it is during a tab switch. Do not mock the addon.
  for (let index = 0; index < 6; index++) {
    const next = make();
    await twoFrames();
    next.slot.classList.add("is-hidden");
    next.controller.setVisible(false);
  }
  await wait(150);
  expect(first.slot.querySelector(".xterm-screen > canvas")).toBeNull();
  const fallback = first.slot.querySelector(".xterm-rows");
  expect(fallback).not.toBeNull();
  expect(fallback!.textContent, "hidden DOM fallback must not paint buffer rows").toBe("");
  expect(first.controller.term.getSelection()).toBe(selection);
  expect(first.controller.term.buffer.active.getLine(999)?.translateToString(true)).toContain(
    "eviction-999",
  );

  const core = first.controller.term as unknown as {
    _core: {
      _renderService: {
        _renderer: {
          value: {
            _widthCache: {
              _measure(chars: string, variant: number): number;
              get(chars: string, bold: boolean, italic: boolean): number;
            };
          };
        };
      };
    };
  };
  const cache = core._core._renderService._renderer.value._widthCache;
  const individualMeasurements = vi.spyOn(cache, "_measure");

  // Showing an evicted tab first paints its fallback, then restores GPU
  // rendering if the user stays on it, without losing its data or selection.
  first.slot.classList.remove("is-hidden");
  first.controller.setVisible(true);
  first.controller.fit(true);
  expect(first.slot.querySelector(".xterm-screen > canvas")).toBeNull();
  expect(first.slot.querySelector(".xterm-rows")!.textContent).toContain("eviction-999");
  expect(individualMeasurements.mock.calls.length).toBeLessThan(5);
  for (const [chars, bold, italic] of [
    ["A", false, false],
    ["中", false, false],
    ["B", true, false],
    ["C", true, true],
    ["D", false, true],
  ] as const) {
    const previousCalls = individualMeasurements.mock.calls.length;
    const batchedWidth = cache.get(chars, bold, italic);
    expect(individualMeasurements.mock.calls.length).toBe(previousCalls);
    const nativeWidth = cache._measure(chars, (bold ? 1 : 0) | (italic ? 2 : 0));
    expect(nativeWidth).toBeGreaterThan(0);
    expect(batchedWidth).toBe(nativeWidth);
  }
  expect(first.controller.term.getSelection()).toBe(selection);
  expect(first.slot.querySelector(".xterm-selection > div")).not.toBeNull();
  await expect.poll(() => first.slot.querySelector(".xterm-screen > canvas")).not.toBeNull();
  expect(first.controller.term.getSelection()).toBe(selection);

  // Turning off the existing GPU preference still paints a visible DOM
  // fallback; the guard must not suppress ordinary visible rendering.
  setWebglEnabled(false);
  first.controller.refreshWebgl();
  first.controller.fit(true);
  first.controller.term.refresh(0, first.controller.term.rows - 1);
  await twoFrames();
  expect(first.slot.querySelector(".xterm-rows")!.textContent).toContain("eviction-999");
  expect(first.controller.term.getSelection()).toBe(selection);

  const resizedCache = core._core._renderService._renderer.value._widthCache;
  const oldWidth = resizedCache.get("A", false, false);
  first.controller.setFontSize(18);
  first.controller.fit(true);
  expect(resizedCache.get("A", false, false)).toBe(resizedCache._measure("A", 0));
  expect(resizedCache.get("A", false, false)).not.toBe(oldWidth);
});
