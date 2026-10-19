import { describe, expect, it } from "vitest";
import {
  pressureOf,
  pushTrend,
  series,
  sparkPaths,
  trendPointFrom,
  type TrendPoint,
  type TrendSource,
} from "./resourceTrend";

const point = (at: number, over: Partial<Omit<TrendPoint, "at">> = {}): TrendPoint => ({
  at,
  cpu: null,
  memory: null,
  net: null,
  ...over,
});

describe("pressure thresholds", () => {
  it("treats a missing reading as fine, never a false alarm", () => {
    expect(pressureOf(null, "cpu")).toBe("ok");
    expect(pressureOf(undefined, "memory")).toBe("ok");
    expect(pressureOf(Number.NaN, "cpu")).toBe("ok");
  });

  it("escalates CPU at 80 and 95", () => {
    expect(pressureOf(79.9, "cpu")).toBe("ok");
    expect(pressureOf(80, "cpu")).toBe("warn");
    expect(pressureOf(94.9, "cpu")).toBe("warn");
    expect(pressureOf(95, "cpu")).toBe("crit");
  });

  it("uses tighter memory cut-offs and its own disk cut-offs", () => {
    expect(pressureOf(89, "memory")).toBe("ok");
    expect(pressureOf(90, "memory")).toBe("warn");
    expect(pressureOf(97, "memory")).toBe("crit");
    expect(pressureOf(84, "disk")).toBe("ok");
    expect(pressureOf(85, "disk")).toBe("warn");
    expect(pressureOf(95, "disk")).toBe("crit");
  });
});

describe("bounded trend history", () => {
  it("appends and drops the oldest past the limit", () => {
    const a = point(1);
    const b = point(2);
    const c = point(3);
    expect(pushTrend([], a, 3)).toEqual([a]);
    expect(pushTrend([a, b], c, 3)).toEqual([a, b, c]);
    expect(pushTrend([a, b, c], point(4), 3)).toEqual([b, c, point(4)]);
  });

  it("keeps only the newest when the limit is one and never mutates the input", () => {
    const input = [point(1), point(2)];
    const next = pushTrend(input, point(3), 1);
    expect(next).toEqual([point(3)]);
    expect(input).toEqual([point(1), point(2)]);
  });

  it("returns a fresh array so a memo only re-runs on a new sample", () => {
    const input = [point(1)];
    expect(pushTrend(input, point(2), 3)).not.toBe(input);
  });
});

describe("projecting a live sample", () => {
  const source: TrendSource = {
    cpuPercent: 42,
    memory: { usedBytes: 500, totalBytes: 1000 },
    networkReceiveBps: 2048,
  };

  it("turns bytes into a RAM percentage and keeps the raw fields", () => {
    expect(trendPointFrom(source, 10)).toEqual({ at: 10, cpu: 42, memory: 50, net: 2048 });
  });

  it("leaves a null gap for an absent or zero-total reading", () => {
    expect(trendPointFrom(null, 1)).toEqual({ at: 1, cpu: null, memory: null, net: null });
    expect(trendPointFrom({ cpuPercent: null, memory: null, networkReceiveBps: null }, 1).memory).toBeNull();
    expect(
      trendPointFrom({ cpuPercent: null, memory: { usedBytes: 0, totalBytes: 0 }, networkReceiveBps: null }, 1).memory,
    ).toBeNull();
  });

  it("selects one series and preserves gaps", () => {
    const history = [point(1, { cpu: 10, net: 100 }), point(2, { cpu: null, net: 400 })];
    expect(series(history, "cpu")).toEqual([10, null]);
    expect(series(history, "net")).toEqual([100, 400]);
  });
});

describe("sparkline geometry", () => {
  it("returns nothing until there are two real points", () => {
    expect(sparkPaths([], 100, 10)).toEqual({ line: "", area: "" });
    expect(sparkPaths([50], 100, 10)).toEqual({ line: "", area: "" });
    expect(sparkPaths([null, null], 100, 10)).toEqual({ line: "", area: "" });
  });

  it("maps two points across the box and closes the area to the baseline", () => {
    expect(sparkPaths([10, 20], 100, 10, 100)).toEqual({
      line: "M0.0 9.0 L100.0 8.0",
      area: "M0.0 9.0 L100.0 8.0 L100.0 10.0 L0.0 10.0 Z",
    });
  });

  it("clamps out-of-range values to the box instead of overflowing it", () => {
    expect(sparkPaths([150, -10], 100, 10, 100).line).toBe("M0.0 0.0 L100.0 10.0");
  });

  it("breaks the line at a null gap rather than bridging it", () => {
    const { line, area } = sparkPaths([null, 50, null, 100], 100, 10, 100);
    expect(line).toBe("M33.3 5.0 M100.0 0.0");
    expect(area).toBe("");
  });
});
