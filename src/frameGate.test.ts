import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFrameGate } from "./frameGate";

// The gate schedules on the window's rAF; a hand-rolled queue makes the
// frame boundary — the behaviour under test — explicit.
let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const scheduled = frames;
  frames = [];
  for (const callback of scheduled) callback(0);
};

beforeAll(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => (frames.push(callback), frames.length),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle > 0 && handle <= frames.length) frames[handle - 1] = () => {};
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  frames = [];
});

describe("createFrameGate", () => {
  it("applies a burst as one call with the latest value", () => {
    const apply = vi.fn();
    const gate = createFrameGate<{ x: number; y: number }>(apply);

    for (let i = 0; i < 50; i += 1) gate.schedule({ x: i, y: i });
    expect(apply).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ x: 49, y: 49 });
  });

  it("reschedules after a frame ran", () => {
    const apply = vi.fn();
    const gate = createFrameGate<number>(apply);

    gate.schedule(1);
    runFrame();
    expect(apply).toHaveBeenCalledWith(1);

    gate.schedule(2);
    expect(frames).toHaveLength(1);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(2);
  });

  it("replaces a value that was scheduled but not applied", () => {
    const apply = vi.fn();
    const gate = createFrameGate<number>(apply);

    gate.schedule(1);
    gate.schedule(2);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(2);
  });

  it("flush applies the pending value now and cancels the frame", () => {
    const apply = vi.fn();
    const gate = createFrameGate<number>(apply);

    gate.schedule(7);
    gate.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(7);

    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending applies nothing", () => {
    const apply = vi.fn();
    const gate = createFrameGate<number>(apply);

    gate.flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancel drops a pending value so a frame cannot fire late", () => {
    const apply = vi.fn();
    const gate = createFrameGate<number>(apply);

    gate.schedule(9);
    gate.cancel();
    runFrame();
    gate.flush();
    expect(apply).not.toHaveBeenCalled();
  });
});
