import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InputLatency,
  LATENCY_FRESH_MS,
  forgetLatency,
  latencyLabel,
  latencyMeter,
  resetLatency,
  subscribeLatency,
} from "./inputLatency";

afterEach(() => {
  resetLatency();
  vi.useRealTimers();
});

describe("InputLatency", () => {
  it("measures the gap from a keystroke to its echo", () => {
    const meter = new InputLatency();
    expect(meter.reading(0)).toBeNull();
    meter.markSent(1_000);
    expect(meter.markOutput(1_042)).toBe(true);
    expect(meter.reading(1_050)).toEqual({ ms: 42, samples: 1 });
  });

  it("only counts the first output after a keystroke", () => {
    const meter = new InputLatency();
    meter.markSent(1_000);
    meter.markOutput(1_030);
    // A command's later output is not another round trip.
    expect(meter.markOutput(1_050)).toBe(false);
    expect(meter.reading(1_100)).toEqual({ ms: 30, samples: 1 });
  });

  it("takes the median of the last few trips", () => {
    const meter = new InputLatency();
    for (const ms of [10, 90, 20]) {
      meter.markSent(0);
      meter.markOutput(ms);
    }
    expect(meter.reading(100)).toEqual({ ms: 20, samples: 3 });
    for (const ms of [40, 30]) {
      meter.markSent(0);
      meter.markOutput(ms);
    }
    // Five samples now: 10, 20, 30, 40, 90 — the median is 30, not the last.
    expect(meter.reading(100)).toEqual({ ms: 30, samples: 5 });
  });

  it("rejects a gap no round trip can explain", () => {
    const meter = new InputLatency();
    meter.markSent(1_000);
    expect(meter.markOutput(1_000 - 5), "a clock that went backwards").toBe(false);
    meter.markSent(1_000);
    expect(meter.markOutput(1_000 + 120_000), "a slept machine").toBe(false);
    expect(meter.reading(1_000)).toBeNull();
  });

  it("goes stale instead of showing an old number", () => {
    const meter = new InputLatency();
    meter.markSent(0);
    meter.markOutput(25);
    expect(meter.reading(25 + LATENCY_FRESH_MS)).toEqual({ ms: 25, samples: 1 });
    expect(meter.reading(25 + LATENCY_FRESH_MS + 1)).toBeNull();
  });

  it("notifies subscribers on a new sample and on expiry", () => {
    vi.useFakeTimers();
    let calls = 0;
    const meter = new InputLatency(() => calls++);
    meter.markSent(0);
    meter.markOutput(20);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(LATENCY_FRESH_MS + 100);
    expect(calls, "expiry re-renders so the chip can disappear").toBe(2);
  });
});

describe("the shared meter registry", () => {
  it("reports one session's label and forgets it on request", () => {
    latencyMeter("s-1").markSent(1_000);
    latencyMeter("s-1").markOutput(1_012);
    expect(latencyLabel("s-1", 1_020, (ms) => ms + " ms")).toBe("12 ms");
    expect(
      latencyLabel("s-2", 1_020, (ms) => ms + " ms"),
      "another session has none",
    ).toBe("");
    expect(latencyLabel(null, 1_020, (ms) => ms + " ms")).toBe("");
    forgetLatency("s-1");
    expect(latencyLabel("s-1", 1_020, (ms) => ms + " ms")).toBe("");
  });

  it("tells subscribers when a sample lands", () => {
    let calls = 0;
    const stop = subscribeLatency(() => calls++);
    latencyMeter("s-3").markSent(0);
    latencyMeter("s-3").markOutput(5);
    stop();
    latencyMeter("s-3").markSent(0);
    latencyMeter("s-3").markOutput(6);
    expect(calls).toBe(1);
  });
});
