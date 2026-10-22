import { memo } from "react";
import { sparkPaths, type Pressure } from "./resourceTrend";

/**
 * A decorative sparkline: a monotone cubic line over a bounded sample series,
 * optionally closed to a soft area and a hairline baseline. The number it
 * summarises is always rendered as text beside it, so the SVG is `aria-hidden`
 * — a screen reader gets the value, never a bare picture. Colour comes from the
 * semantic tokens via CSS (`tone-*` plus `currentColor`), so all four themes
 * hold without this component knowing any hex value. Memoised on the series
 * array: callers pass a stable reference (a `useMemo` over history) so a poll
 * that changes nothing does not re-render the SVG.
 */
export const Sparkline = memo(function Sparkline({
  values,
  width = 76,
  height = 20,
  max = 100,
  tone = "ok",
  area = true,
  baseline = false,
  className,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  max?: number;
  tone?: Pressure;
  /** Draw the soft fill below the line. */
  area?: boolean;
  /** Draw the hairline the fill closes to; reads as an instrument baseline. */
  baseline?: boolean;
  /** Extra placement class, for callers that stretch the box. */
  className?: string;
}) {
  const { line, area: fill } = sparkPaths(values, width, height, max);
  const classes = ["spark", `tone-${tone}`, className].filter(Boolean).join(" ");
  if (!line) {
    // Not enough samples yet (the first delta reading, an unsupported host):
    // an empty track reads as "warming up" rather than a broken widget.
    return (
      <svg
        className={`${classes} is-empty`}
        width={width}
        height={height}
        aria-hidden="true"
        focusable="false"
      />
    );
  }
  return (
    <svg
      className={classes}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {baseline && (
        <line className="spark-base" x1={0} y1={height} x2={width} y2={height} />
      )}
      {area && fill && <path className="spark-area" d={fill} />}
      <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
