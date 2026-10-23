import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilerColumnResizer } from "./FilerColumnResizer";

let host: HTMLDivElement;
let root: Root;
let handle: HTMLDivElement;
let captured: Set<number>;
let resize: ReturnType<typeof vi.fn<(startWidth: number, delta: number) => void>>;
let start: ReturnType<typeof vi.fn<() => void>>;

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
  start = vi.fn();
  render();
  // jsdom has no native pointer capture; only that browser boundary is
  // mocked, the way Splitter.test.ts mocks it. The handle measures its
  // owning cell's width at pointerdown and jsdom lays nothing out, so the
  // cell reports 0 — the reported pair is (0, total), which is exactly the
  // contract the panel consumes.
  handle.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  handle.hasPointerCapture = vi.fn((id: number) => captured.has(id));
  handle.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(onResize = resize, onStart = start) {
  act(() =>
    root.render(
      h("div", null, h(FilerColumnResizer, { label: "test", onStart, onResize })),
    ),
  );
  handle = host.querySelector(".filer-col-resize") as HTMLDivElement;
}

function pointer(type: string, props: Partial<PointerEventInit> = {}, target: EventTarget = handle) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  const fields = { pointerId: 1, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 1, clientX: 100, clientY: 100, ...props };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { value });
  }
  act(() => target.dispatchEvent(event));
}

describe("FilerColumnResizer drag lifecycle", () => {
  it("batches movement into one cumulative report per frame", () => {
    expect(start).not.toHaveBeenCalled();
    pointer("pointerdown");
    expect(start).toHaveBeenCalledTimes(1);
    pointer("pointermove", { clientX: 110 });
    pointer("pointermove", { clientX: 115 });
    expect(resize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));
    // One application for the frame, reporting the accumulated movement
    // since the drag began — not one call per pointermove.
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(0, 15);
    pointer("pointermove", { clientX: 118 });
    pointer("pointerup", { buttons: 0 });
    pointer("lostpointercapture");
    act(() => vi.advanceTimersByTime(32));
    // The release flushed the 3px that never got a frame of its own, and
    // the report is still the accumulated total from the drag's start.
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith(0, 18);
    expect(handle.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
  });

  it("applies movement that is released before its frame could run", () => {
    // The regression: a quick drag — press, one move, release within one
    // frame — must land the move. `finish` retires the drag before it
    // flushes the batch, so the flush may not depend on the retired ref to
    // find the drag it is still allowed to apply.
    pointer("pointerdown");
    pointer("pointermove", { clientX: 130 });
    expect(resize).not.toHaveBeenCalled();
    pointer("pointerup", { buttons: 0 });
    act(() => vi.advanceTimersByTime(32));
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(0, 30);
    expect(handle.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
  });

  it("drops queued movement when the drag is cancelled", () => {
    pointer("pointerdown");
    pointer("pointermove", { clientX: 130 });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => vi.advanceTimersByTime(32));
    expect(resize).not.toHaveBeenCalled();
    expect(handle.classList.contains("is-dragging")).toBe(false);
    expect(captured.size).toBe(0);
  });
});
