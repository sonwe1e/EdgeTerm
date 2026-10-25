// Trend maths for the resource monitor and the workbench host strip, kept as
// pure functions so the sparkline geometry, the pressure thresholds and the
// bounded history can be unit-tested without a DOM or a live sample. Both the
// status-bar monitor (ResourceMonitorBar) and the host strip import from here;
// nothing in this module touches React, the store or IPC.

/** One compacted sample: only the numbers the sparklines plot, not the whole
 *  ResourceMetrics the poller already holds. Small and fixed-shape so a long
 *  session cannot grow the trend window without bound. */
export interface TrendPoint {
  at: number;
  cpu: number | null;
  /** Percent of RAM in use, 0..100. */
  memory: number | null;
  /** Percent of the root filesystem in use, 0..100. */
  disk: number | null;
  /** Network receive, bytes per second. */
  net: number | null;
  /** Peak utilization across the detected GPUs, 0..100. */
  gpu: number | null;
  /** Peak utilization across the detected accelerators, 0..100. */
  npu: number | null;
}

/** The shape trendPointFrom reads off a live sample. api.ResourceMetrics
 *  satisfies it structurally, so callers pass the real object and tests build a
 *  minimal literal. The device lists and the filesystem are optional: a caller
 *  that only plots the host gauges need not synthesise them. */
export interface TrendSource {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  networkReceiveBps: number | null;
  capacity?: { usedBytes: number; totalBytes: number } | null;
  gpus?: readonly { utilization: number | null }[];
  npus?: readonly { utilization: number | null }[];
}

/** How full a "fuller is worse" gauge is. Drives colour only; the numeric text
 *  beside the sparkline stays the accessible source of truth. */
export type Pressure = "ok" | "warn" | "crit";

/**
 * Warn/crit cut-offs per gauge. These are deliberate, not magic: a shared box
 * idles well under 80% CPU, RAM past 90% is close to the OOM killer on a
 * typical Linux host, and a root filesystem past 85% starts to hurt. crit is
 * the point where the user should look now rather than soon. An accelerator's
 * utilization is not a fault when it is high — a training GPU is meant to be
 * pinned — so its tiers only mark saturation, not danger.
 */
export const THRESHOLDS = {
  cpu: { warn: 80, crit: 95 },
  memory: { warn: 90, crit: 97 },
  disk: { warn: 85, crit: 95 },
  accelerator: { warn: 90, crit: 99 },
} as const;

export type MetricKind = keyof typeof THRESHOLDS;

/** Classifies a percentage against a gauge's thresholds. A missing value (the
 *  first delta sample, an unsupported host) is "ok", never a false alarm. */
export function pressureOf(value: number | null | undefined, kind: MetricKind): Pressure {
  if (value === null || value === undefined || !Number.isFinite(value)) return "ok";
  const { warn, crit } = THRESHOLDS[kind];
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

/** The busiest utilization in a device list. One number is what the status bar
 *  can show, and the busiest accelerator is the one worth looking at; an empty
 *  list, or one whose devices report no utilization, stays null rather than
 *  pretending the hardware is idle. */
export function peakUtilization(
  devices: readonly { utilization: number | null }[] | null | undefined,
): number | null {
  let peak: number | null = null;
  for (const device of devices ?? []) {
    const value = device.utilization;
    if (value === null || !Number.isFinite(value)) continue;
    peak = peak === null ? value : Math.max(peak, value);
  }
  return peak;
}

/**
 * How many samples a trend keeps. A fixed count, not a fixed time span: at a
 * 1s interval this is the last minute, at the 30s maximum the last half hour,
 *  and either way the array is capped so memory stays flat. 60 points is more
 * than a sparkline can show and cheap to hold.
 */
export const TREND_LIMIT = 60;

/** Appends a sample and drops the oldest beyond `limit`. Returns a fresh array
 *  (so a memo on the result only re-runs when a sample actually arrives) and
 *  never mutates the input. */
export function pushTrend(
  history: readonly TrendPoint[],
  point: TrendPoint,
  limit: number = TREND_LIMIT,
): TrendPoint[] {
  const cap = Math.max(1, Math.floor(limit));
  const kept = history.length >= cap ? history.slice(history.length - cap + 1) : history.slice();
  kept.push(point);
  return kept;
}

/** Projects a live sample onto the plotted numbers. A zero/absent total or a
 *  null field stays null so the sparkline draws a gap instead of a fake zero. */
export function trendPointFrom(metrics: TrendSource | null | undefined, at: number): TrendPoint {
  const memory = metrics?.memory;
  const memoryTotal = memory?.totalBytes ?? 0;
  const disk = metrics?.capacity;
  const diskTotal = disk?.totalBytes ?? 0;
  return {
    at,
    cpu: metrics?.cpuPercent ?? null,
    memory: memory && memoryTotal > 0 ? (memory.usedBytes / memoryTotal) * 100 : null,
    disk: disk && diskTotal > 0 ? (disk.usedBytes / diskTotal) * 100 : null,
    net: metrics?.networkReceiveBps ?? null,
    gpu: peakUtilization(metrics?.gpus),
    npu: peakUtilization(metrics?.npus),
  };
}

/** Picks the series a sparkline plots, preserving null gaps. */
export function series(
  history: readonly TrendPoint[],
  field: keyof Omit<TrendPoint, "at">,
): (number | null)[] {
  return history.map((point) => point[field]);
}

export interface SparkPaths {
  /** A path per contiguous run; empty when there is no trend. */
  line: string;
  /** The same runs closed to the baseline for a soft area fill. */
  area: string;
}

interface Point {
  x: number;
  y: number;
}

const round = (value: number): string => value.toFixed(1);

/**
 * Builds SVG path data for a `width`×`height` sparkline, mapping values onto a
 * 0..`max` range. The line is a monotone cubic: it bends between samples
 * without overshooting them, so a peak stays where the data put it. A null
 * sample starts a fresh subpath, so the first-sample hole and a dropped poll
 * break the line rather than drawing a misleading straight segment across the
 * gap. Fewer than two real points in a run return empty strings — one dot is
 * not a trend. Coordinates are rounded to 0.1px to keep the path string short
 * and stable between renders.
 */
export function sparkPaths(
  values: readonly (number | null)[],
  width: number,
  height: number,
  max = 100,
): SparkPaths {
  const span = values.length - 1;
  // A non-positive ceiling would divide by zero; every caller that scales to a
  // measured peak already floors it, and this keeps the pure function safe.
  const ceiling = Number.isFinite(max) && max > 0 ? max : 100;
  const runs: Point[][] = [];
  let current: Point[] | null = null;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      current = null;
      return;
    }
    const x = span <= 0 ? width : (index / span) * width;
    const clamped = Math.max(0, Math.min(ceiling, value));
    const y = height - (clamped / ceiling) * height;
    if (!current) {
      current = [];
      runs.push(current);
    }
    current.push({ x, y });
  });
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  if (total < 2) return { line: "", area: "" };
  const lines: string[] = [];
  const areas: string[] = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    const curve = runPath(run);
    lines.push(curve);
    const last = run[run.length - 1];
    areas.push(
      `${curve} L${round(last.x)} ${round(height)} L${round(run[0].x)} ${round(height)} Z`,
    );
  }
  return { line: lines.join(" "), area: areas.join(" ") };
}

/** The curve through one run. Two points are already a straight segment, so
 *  they stay a single `L`; longer runs get cubic Hermite segments whose
 *  tangents monotoneTangents has limited. */
function runPath(points: Point[]): string {
  const head = `M${round(points[0].x)} ${round(points[0].y)}`;
  if (points.length === 2) {
    return `${head} L${round(points[1].x)} ${round(points[1].y)}`;
  }
  const tangents = monotoneTangents(points);
  let path = head;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const third = (to.x - from.x) / 3;
    const control = (y: number, tangent: number) => round(y + tangent * third);
    path +=
      ` C${round(from.x + third)} ${control(from.y, tangents[index - 1])}` +
      ` ${round(to.x - third)} ${control(to.y, -tangents[index])}` +
      ` ${round(to.x)} ${round(to.y)}`;
  }
  return path;
}

/**
 * Fritsch–Carlson tangents: each point starts at the average of its two
 * neighbouring slopes, then every tangent is limited so no segment can swing
 * past its endpoints. This is what keeps a sparkline honest — a curve that
 * bowed above a 40% peak would read as 45%.
 */
function monotoneTangents(points: Point[]): number[] {
  const count = points.length;
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    const dy = points[index + 1].y - points[index].y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = new Array<number>(count);
  tangents[0] = slopes[0];
  tangents[count - 1] = slopes[count - 2];
  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1];
    const after = slopes[index];
    tangents[index] = before * after <= 0 ? 0 : (before + after) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const before = tangents[index] / slope;
    const after = tangents[index + 1] / slope;
    const magnitude = before * before + after * after;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * before * slope;
      tangents[index + 1] = scale * after * slope;
    }
  }
  return tangents;
}
