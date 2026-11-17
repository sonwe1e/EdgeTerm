import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createResizeCoalescer } from "./resizeCoalescer";

let sent: Array<[number, number]> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_000);
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const coalescer = (intervalMs = 100) =>
  createResizeCoalescer((cols, rows) => sent.push([cols, rows]), intervalMs);

describe("a pane drag's grid reports", () => {
  it("sends the first one at once and the last one after the burst", () => {
    const resize = coalescer();
    // Sixty frames of a drag, each its own event.
    for (let cols = 100; cols < 160; cols += 1) resize.request(cols, 40);
    // The user sees the first frame's size immediately.
    expect(sent).toEqual([[100, 40]]);

    vi.advanceTimersByTime(99);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // And the drag ends at the size it actually stopped on.
    expect(sent).toEqual([
      [100, 40],
      [159, 40],
    ]);
  });

  it("sends each report when they are spaced further apart than the interval", () => {
    const resize = coalescer();
    resize.request(100, 40);
    vi.advanceTimersByTime(150);
    resize.request(110, 40);
    vi.advanceTimersByTime(150);
    resize.request(120, 40);
    expect(sent).toEqual([
      [100, 40],
      [110, 40],
      [120, 40],
    ]);
  });

  it("flushes the queued size without waiting out the interval", () => {
    const resize = coalescer();
    resize.request(100, 40);
    resize.request(120, 40);
    resize.flush();
    expect(sent).toEqual([
      [100, 40],
      [120, 40],
    ]);
    // Nothing is left to send twice.
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(2);
  });

  it("drops the queued size when the session is going away", () => {
    const resize = coalescer();
    resize.request(100, 40);
    resize.request(130, 40);
    resize.cancel();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([[100, 40]]);
  });

  it("flushes nothing when no report is queued", () => {
    const resize = coalescer();
    resize.flush();
    expect(sent).toEqual([]);
  });
});
