import { describe, expect, it } from "vitest";

// Real stylesheet, real layout: this file runs in the browser project, which
// deliberately does not load src/test/setup.ts (the jsdom stubs for canvas,
// matchMedia and rAF). It proves the runner sees real pixels before the
// layout contracts build on it.
import "../styles.css";

describe("the browser test environment", () => {
  it("lays elements out for real, without the jsdom stubs", () => {
    const frame = document.createElement("div");
    frame.style.position = "relative";
    frame.style.width = "600px";
    frame.style.height = "400px";
    const slot = document.createElement("div");
    slot.className = "pane-slot";
    slot.style.left = "0%";
    slot.style.top = "0%";
    slot.style.width = "100%";
    slot.style.height = "100%";
    frame.append(slot);
    document.body.append(frame);

    const rect = slot.getBoundingClientRect();
    expect(rect.width).toBe(600);
    expect(rect.height).toBe(400);

    // These three are stubbed (or absent) under jsdom's setup file; the
    // browser must answer with the real implementations.
    const canvas = document.createElement("canvas");
    expect(canvas.getContext("2d")).not.toBeNull();
    expect(typeof window.ResizeObserver).toBe("function");
    expect(typeof window.PointerEvent).toBe("function");

    frame.remove();
  });
});
