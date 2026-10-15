import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Splitter } from "./Splitter";

let host: HTMLDivElement;
let root: Root;
let splitter: HTMLDivElement;
let captured: Set<number>;
let resize: ReturnType<typeof vi.fn<(delta: number) => void>>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  captured = new Set();
  resize = vi.fn();
  render();
  // jsdom has no native pointer capture. Only that browser boundary is mocked;
  // events still exercise the mounted component and its real frame batch.
  splitter.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  splitter.hasPointerCapture = vi.fn((id: number) => captured.has(id));
  splitter.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(orientation: "vertical" | "horizontal" = "vertical", onResize = resize) {
  act(() => root.render(h(Splitter, { orientation, onResize })));
  splitter = host.firstElementChild as HTMLDivElement;
}

function pointer(type: string, props: Partial<PointerEventInit> = {}, target: EventTarget = splitter) {
  // Explicit fields also work on jsdom versions without a PointerEvent class.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  const fields = { pointerId: 1, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 1, clientX: 100, clientY: 100, ...props };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { value });
  }
  act(() => target.dispatchEvent(event));
}

function pendingDrag() {
  pointer("pointerdown");
  pointer("pointermove", { clientX: 130 });
  expect(splitter.classList.contains("is-dragging")).toBe(true);
  expect(resize).not.toHaveBeenCalled();
}

function expectStopped() {
  expect(splitter.classList.contains("is-dragging")).toBe(false);
  expect(captured.size).toBe(0);
  pointer("pointermove", { clientX: 160 });
  act(() => vi.advanceTimersByTime(32));
  expect(resize).not.toHaveBeenCalled();
  // A terminated drag must not prevent starting another one.
  pointer("pointerdown");
  pointer("pointermove", { clientX: 110 });
  pointer("pointerup", { buttons: 0 });
  expect(resize.mock.calls).toEqual([[10]]);
}

describe("Splitter drag lifecycle", () => {
  it.each(["vertical", "horizontal"] as const)("batches %s movement and flushes the final delta once", (orientation) => {
    render(orientation);
    pointer("pointerdown");
    pointer("pointermove", { clientX: 110, clientY: 120 });
    pointer("pointermove", { clientX: 115, clientY: 130 });
    expect(resize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));
    expect(resize.mock.calls).toEqual([[orientation === "vertical" ? 15 : 30]]);
    pointer("pointermove", { clientX: 118, clientY: 134 });
    pointer("pointerup", { buttons: 0 });
    pointer("lostpointercapture");
    act(() => vi.advanceTimersByTime(32));
    expect(resize.mock.calls).toEqual(orientation === "vertical" ? [[15], [3]] : [[30], [4]]);
    expect(splitter.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "Escape", "hidden"])("cancels queued work on %s and permits a new drag", (reason) => {
    pendingDrag();
    if (reason === "blur") {
      act(() => window.dispatchEvent(new Event("blur")));
    } else if (reason === "Escape") {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    } else if (reason === "hidden") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      vi.restoreAllMocks();
    } else {
      if (reason === "lostpointercapture") captured.clear();
      pointer(reason);
    }
    expectStopped();
  });

  it("ends a drag when mouse moves with the primary button already released", () => {
    pendingDrag();
    pointer("pointermove", { clientX: 140, buttons: 0 });
    expectStopped();
  });

  it("observes pointer-up outside the splitter when capture was interrupted", () => {
    pendingDrag();
    pointer("pointerup", { buttons: 0 }, document.body);
    expect(resize.mock.calls).toEqual([[30]]);
    expect(splitter.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
    act(() => vi.advanceTimersByTime(32));
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("observes cancellation outside the splitter", () => {
    pendingDrag();
    pointer("pointercancel", {}, document.body);
    expectStopped();
  });

  it.each([
    { button: 2, buttons: 2 },
    { isPrimary: false },
  ])("does not start a drag for non-primary input %j", (props) => {
    pointer("pointerdown", props);
    pointer("pointermove", { clientX: 130 });
    act(() => vi.advanceTimersByTime(32));
    expect(resize).not.toHaveBeenCalled();
    expect(splitter.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
  });

  it("ignores another pointer's moves, termination and new press", () => {
    pointer("pointerdown");
    pointer("pointerdown", { pointerId: 2, clientX: 200 });
    pointer("pointermove", { pointerId: 2, clientX: 250 });
    pointer("pointerup", { pointerId: 2, buttons: 0 });
    pointer("pointercancel", { pointerId: 2 });
    pointer("lostpointercapture", { pointerId: 2 });
    expect(splitter.classList.contains("is-dragging")).toBe(true);
    expect(captured).toEqual(new Set([1]));
    pointer("pointermove", { clientX: 110 });
    pointer("pointerup", { buttons: 0 });
    expect(resize.mock.calls).toEqual([[10]]);
  });

  it("drops queued movement and releases capture on unmount", () => {
    pendingDrag();
    act(() => root.render(null));
    expect(captured.size).toBe(0);
    pointer("pointerup", { buttons: 0 }, window);
    act(() => vi.advanceTimersByTime(32));
    expect(resize).not.toHaveBeenCalled();
  });

  it("cancels a drag when the splitter changes orientation", () => {
    pendingDrag();
    render("horizontal");
    expect(splitter.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
    act(() => vi.advanceTimersByTime(32));
    expect(resize).not.toHaveBeenCalled();
    pointer("pointerdown");
    pointer("pointermove", { clientY: 120 });
    pointer("pointerup", { buttons: 0 });
    expect(resize.mock.calls).toEqual([[20]]);
  });

  it("does not leave drag state when capture loses the pointer before starting", () => {
    vi.mocked(splitter.setPointerCapture).mockImplementationOnce(() => {
      throw new DOMException("Pointer is gone", "NotFoundError");
    });
    pointer("pointerdown");
    expectStopped();
  });

  it("cleans state and queued work even if release reports an expired pointer", () => {
    pendingDrag();
    vi.mocked(splitter.releasePointerCapture).mockImplementationOnce((id) => {
      captured.delete(id);
      throw new DOMException("Pointer is gone", "NotFoundError");
    });
    act(() => window.dispatchEvent(new Event("blur")));
    expectStopped();
  });

  it("removes fallback listeners once a drag ends", () => {
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    pendingDrag();
    pointer("pointerup", { buttons: 0 });
    for (const [name, capture] of [["pointerup", true], ["pointercancel", true],
      ["blur", undefined], ["keydown", true]] as const) {
      const args = capture === undefined ? [name, expect.any(Function)] : [name, expect.any(Function), capture];
      expect(windowRemove).toHaveBeenCalledWith(...args);
    }
    expect(documentRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(resize.mock.calls).toEqual([[30]]);
  });

  it("uses the latest resize callback after rendering during a drag", () => {
    pendingDrag();
    const next = vi.fn();
    render("vertical", next);
    pointer("pointerup", { buttons: 0 });
    expect(resize).not.toHaveBeenCalled();
    expect(next.mock.calls).toEqual([[30]]);
  });
});
