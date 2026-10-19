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
  /** Network receive, bytes per second. */
  net: number | null;
}

/** The shape trendPointFrom reads off a live sample. api.ResourceMetrics
 *  satisfies it structurally, so callers pass the real object and tests build a
 *  minimal literal. */
export interface TrendSource {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  networkReceiveBps: number | null;
}

/** How full a "fuller is worse" gauge is. Drives colour only; the numeric text
 *  beside the sparkline stays the accessible source of truth. */
export type Pressure = "ok" | "warn" | "crit";

/**
 * Warn/crit cut-offs per gauge. These are deliberate, not magic: a shared box
 * idles well under 80% CPU, RAM past 90% is close to the OOM killer on a
 * typical Linux host, and a root filesystem past 85% starts to hurt. crit is
 * the point where the user should look now rather than soon.
 */
export const THRESHOLDS = {
  cpu: { warn: 80, crit: 95 },
  memory: { warn: 90, crit: 97 },
  disk: { warn: 85, crit: 95 },
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

/**
 * How many samples a trend keeps. A fixed count, not a fixed time span: at a
 * 1s interval this is the last minute, at the 30s maximum the last half hour,
 *  and either way the array is capped so memory stays flat. 60 points is more
 *  than a sparkline can show and cheap to hold.
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
  const total = memory?.totalBytes ?? 0;
  return {
    at,
    cpu: metrics?.cpuPercent ?? null,
    memory: memory && total > 0 ? (memory.usedBytes / total) * 100 : null,
    net: metrics?.networkReceiveBps ?? null,
  };
}

/** Picks the series a sparkline plots, preserving null gaps. */
export function series(history: readonly TrendPoint[], field: keyof Omit<TrendPoint, "at">): (number | null)[] {
  return history.map((point) => point[field]);
}

export interface SparkPaths {
  /** A polyline (`M`/`L`) per contiguous run; empty when there is no trend. */
  line: string;
  /** The same runs closed to the baseline for a soft area fill. */
  area: string;
}

const round = (value: number): string => value.toFixed(1);

/**
 * Builds SVG path data for a `width`×`height` sparkline, mapping values onto a
 * 0..`max` range. A null sample starts a fresh subpath, so the first-sample
 * hole and a dropped poll break the line rather than drawing a misleading
 * straight segment across the gap. Fewer than two real points return empty
 * strings — one dot is not a trend. Coordinates are rounded to 0.1px to keep
 * the path string short and stable between renders.
 */
export function sparkPaths(
  values: readonly (number | null)[],
  width: number,
  height: number,
  max = 100,
): SparkPaths {
  const span = values.length - 1;
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] | null = null;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      current = null;
      return;
    }
    const x = span <= 0 ? width : (index / span) * width;
    const clamped = Math.max(0, Math.min(max, value));
    const y = height - (clamped / max) * height;
    if (!current) {
      current = [];
      runs.push(current);
    }
    current.push({ x, y });
  });
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  if (total < 2) return { line: "", area: "" };
  let line = "";
  let area = "";
  for (const run of runs) {
    const head = `M${round(run[0].x)} ${round(run[0].y)}`;
    const tail = run.slice(1).map((point) => `L${round(point.x)} ${round(point.y)}`).join(" ");
    line += `${head}${tail ? ` ${tail}` : ""} `;
    if (run.length >= 2) {
      const last = run[run.length - 1];
      area += `${head}${tail ? ` ${tail}` : ""} L${round(last.x)} ${round(height)} L${round(run[0].x)} ${round(height)} Z `;
    }
  }
  return { line: line.trim(), area: area.trim() };
}
