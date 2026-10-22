import { describe, expect, it } from "vitest";
import {
  peakUtilization,
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
  disk: null,
  net: null,
  gpu: null,
  npu: null,
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

  it("marks accelerators only once they are saturated", () => {
    expect(pressureOf(89, "accelerator")).toBe("ok");
    expect(pressureOf(90, "accelerator")).toBe("warn");
    expect(pressureOf(98.9, "accelerator")).toBe("warn");
    expect(pressureOf(99, "accelerator")).toBe("crit");
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
    capacity: { usedBytes: 250, totalBytes: 1000 },
    gpus: [{ utilization: 12 }, { utilization: 64 }],
    npus: [{ utilization: null }, { utilization: 30 }],
  };

  it("turns bytes into percentages and keeps the raw rate", () => {
    expect(trendPointFrom(source, 10)).toEqual({
      at: 10,
      cpu: 42,
      memory: 50,
      disk: 25,
      net: 2048,
      gpu: 64,
      npu: 30,
    });
  });

  it("leaves a null gap for an absent or zero-total reading", () => {
    expect(trendPointFrom(null, 1)).toEqual({
      at: 1,
      cpu: null,
      memory: null,
      disk: null,
      net: null,
      gpu: null,
      npu: null,
    });
    expect(trendPointFrom({ cpuPercent: null, memory: null, networkReceiveBps: null }, 1).memory).toBeNull();
    expect(
      trendPointFrom({ cpuPercent: null, memory: { usedBytes: 0, totalBytes: 0 }, networkReceiveBps: null }, 1).memory,
    ).toBeNull();
    expect(
      trendPointFrom(
        { cpuPercent: null, memory: null, networkReceiveBps: null, capacity: { usedBytes: 5, totalBytes: 0 } },
        1,
      ).disk,
    ).toBeNull();
    // A host with no accelerator reports no accelerator series, not a zero.
    expect(trendPointFrom({ cpuPercent: null, memory: null, networkReceiveBps: null, gpus: [], npus: [] }, 1)).toMatchObject(
      { gpu: null, npu: null },
    );
  });

  it("selects one series and preserves gaps", () => {
    const history = [point(1, { cpu: 10, net: 100 }), point(2, { cpu: null, net: 400 })];
    expect(series(history, "cpu")).toEqual([10, null]);
    expect(series(history, "net")).toEqual([100, 400]);
    expect(series(history, "npu")).toEqual([null, null]);
  });
});

describe("accelerator peak", () => {
  it("takes the busiest device and ignores unknown readings", () => {
    expect(peakUtilization([{ utilization: 8 }, { utilization: 61 }])).toBe(61);
    expect(peakUtilization([{ utilization: null }, { utilization: 12 }])).toBe(12);
  });

  it("stays null for an empty list or one without readings", () => {
    expect(peakUtilization([])).toBeNull();
    expect(peakUtilization(undefined)).toBeNull();
    expect(peakUtilization([{ utilization: null }])).toBeNull();
  });
});

/** The cubic segments of a sparkline path, read back out of its `d` string. */
function segments(path: string) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const parsed: { from: [number, number]; to: [number, number]; ys: number[] }[] = [];
  let start: [number, number] = [numbers[0], numbers[1]];
  for (let index = 2; index + 5 < numbers.length; index += 6) {
    const ys = [start[1]];
    for (let step = 1; step <= 10; step += 1) {
      const t = step / 10;
      const m = 1 - t;
      const value =
        m * m * m * start[1] +
        3 * m * m * t * numbers[index + 1] +
        3 * m * t * t * numbers[index + 3] +
        t * t * t * numbers[index + 5];
      ys.push(value);
    }
    const to: [number, number] = [numbers[index + 4], numbers[index + 5]];
    parsed.push({ from: start, to, ys });
    start = to;
  }
  return parsed;
}

describe("sparkline geometry", () => {
  it("returns nothing until there are two real points", () => {
    expect(sparkPaths([], 100, 10)).toEqual({ line: "", area: "" });
    expect(sparkPaths([50], 100, 10)).toEqual({ line: "", area: "" });
    expect(sparkPaths([null, null], 100, 10)).toEqual({ line: "", area: "" });
  });

  it("maps a two-point run across the box and closes the area to the baseline", () => {
    expect(sparkPaths([10, 20], 100, 10, 100)).toEqual({
      line: "M0.0 9.0 L100.0 8.0",
      area: "M0.0 9.0 L100.0 8.0 L100.0 10.0 L0.0 10.0 Z",
    });
  });

  it("clamps out-of-range values to the box instead of overflowing it", () => {
    expect(sparkPaths([150, -10], 100, 10, 100).line).toBe("M0.0 0.0 L100.0 10.0");
  });

  it("draws a smooth curve through every sample without overshooting", () => {
    // A plateau after a climb is where a naive Catmull-Rom bows above the data.
    const { line } = sparkPaths([0, 60, 100, 100, 100, 40], 100, 10, 100);
    expect(line.startsWith("M0.0 10.0")).toBe(true);
    expect(line).toContain(" C");
    // Coordinates are drawn rounded to 0.1px, so the band allows that much.
    const slack = 0.06;
    const drawn = segments(line);
    expect(drawn).toHaveLength(5);
    for (const segment of drawn) {
      const low = Math.min(segment.from[1], segment.to[1]);
      const high = Math.max(segment.from[1], segment.to[1]);
      for (const y of segment.ys) {
        expect(y).toBeGreaterThanOrEqual(low - slack);
        expect(y).toBeLessThanOrEqual(high + slack);
        expect(y).toBeGreaterThanOrEqual(-slack);
        expect(y).toBeLessThanOrEqual(10 + slack);
      }
    }
  });

  it("passes through every sample, so a peak is drawn where the data put it", () => {
    const { line } = sparkPaths([10, 30, 80, 90], 100, 10, 100);
    // 0..100 over 0..100px: x by index, y = 10 − value/10.
    expect(segments(line).map((segment) => segment.to)).toEqual([
      [33.3, 7],
      [66.7, 2],
      [100, 1],
    ]);
  });

  it("breaks the line at a null gap rather than bridging it", () => {
    const { line, area } = sparkPaths([null, 50, null, 100], 100, 10, 100);
    expect(line).toBe("");
    expect(area).toBe("");
    const split = sparkPaths([10, 20, null, 30, 40], 100, 10, 100);
    expect(split.line.split("M")).toHaveLength(3);
    expect(split.area.split("Z").filter(Boolean)).toHaveLength(2);
  });
});
