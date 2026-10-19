import { memo } from "react";
import { sparkPaths, type Pressure } from "./resourceTrend";

/**
 * A decorative sparkline: a thin area-plus-line over a bounded sample series.
 * The number it summarises is always rendered as text beside it, so the SVG is
 * `aria-hidden` — a screen reader gets the value, never a bare picture. Colour
 * comes from the semantic tokens via CSS (`tone-*`), so all four themes hold
 * without this component knowing any hex value. Memoised on the series array:
 * callers pass a stable reference (a `useMemo` over history) so a poll that
 * changes nothing does not re-render the SVG.
 */
export const Sparkline = memo(function Sparkline({
  values,
  width = 76,
  height = 20,
  max = 100,
  tone = "ok",
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  max?: number;
  tone?: Pressure;
}) {
  const { line, area } = sparkPaths(values, width, height, max);
  if (!line) {
    // Not enough samples yet (the first delta reading, an unsupported host):
    // an empty track reads as "warming up" rather than a broken widget.
    return <svg className="spark is-empty" width={width} height={height} aria-hidden="true" focusable="false" />;
  }
  return (
    <svg
      className={`spark tone-${tone}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {area && <path className="spark-area" d={area} />}
      <path className="spark-line" d={line} />
    </svg>
  );
});
