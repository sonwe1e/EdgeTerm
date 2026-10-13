import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFrameBatch } from "./frameBatch";

// The batch schedules on the window's rAF; a hand-rolled queue makes the
// frame boundary — the whole behaviour under test — explicit and immediate.
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

describe("createFrameBatch", () => {
  it("applies deltas only when their frame runs", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(5);
    batch.push(3);
    expect(apply).not.toHaveBeenCalled();

    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(8);
  });

  it("sums opposing deltas algebraically", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(10);
    batch.push(-4);
    batch.push(-2);
    runFrame();
    expect(apply).toHaveBeenCalledWith(4);
  });

  it("schedules one frame for a burst and reschedules after it runs", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(1);
    batch.push(1);
    expect(frames).toHaveLength(1);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);

    batch.push(1);
    expect(frames).toHaveLength(1);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("does not apply an all-zero frame", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(0);
    runFrame();
    expect(apply).not.toHaveBeenCalled();
  });

  it("flush applies the pending sum at once and cancels the frame", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(7);
    batch.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(7);

    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending applies nothing", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancel drops the pending deltas", () => {
    const apply = vi.fn();
    const batch = createFrameBatch(apply);

    batch.push(9);
    batch.cancel();
    runFrame();
    batch.flush();
    expect(apply).not.toHaveBeenCalled();
  });
});
