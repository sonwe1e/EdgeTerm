import { useMemo } from "react";
import type { DiffRow } from "../api";
import type { DiffChange } from "../fileDiffLayout";
import { useT } from "../useT";

export function FileDiffOverview({ rows, changes, first, last, previous, next, onJump }: {
  rows: readonly DiffRow[];
  changes: readonly DiffChange[];
  first: number;
  last: number;
  previous: number;
  next: number;
  onJump: (index: number) => void;
}) {
  const t = useT();
  // Logical rows keep markers fixed while wrapped rows are measured or resized.
  // At most 400 bins per kind bound the overview DOM even for alternating changes.
  const markers = useMemo(() => {
    const bins = new Map<string, { kind: DiffRow["kind"]; start: number; end: number }>();
    rows.forEach((row, index) => {
      if (row.kind === "equal") return;
      const key = `${Math.floor(index / rows.length * 400)}:${row.kind}`;
      const bin = bins.get(key);
      if (bin) bin.end = index + 1;
      else bins.set(key, { kind: row.kind, start: index, end: index + 1 });
    });
    return [...bins.values()];
  }, [rows]);

  return <div className="file-diff-overview" role="slider" tabIndex={0}
    aria-label={t("diff.overviewAria")}
    aria-valuemin={1} aria-valuemax={rows.length} aria-valuenow={first + 1}
    aria-valuetext={t("diff.overviewPosition", { line: first + 1, total: rows.length })}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.focus();
      const box = event.currentTarget.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
      const target = Math.min(rows.length - 1, Math.floor(fraction * rows.length));
      // A six-pixel target makes even a one-line change easy to hit, without
      // creating thousands of focusable buttons in the modal's tab order.
      const nearest = changes.reduce<DiffChange | null>((best, change) =>
        !best || Math.abs(change.start - target) < Math.abs(best.start - target) ? change : best, null);
      const nearMarker = nearest && Math.abs(nearest.start - target) / rows.length * box.height < 6;
      onJump(nearMarker ? nearest.start : target);
    }}
    onKeyDown={(event) => {
      const target = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
        : event.key === "ArrowDown" ? (next >= 0 ? changes[next].start : rows.length - 1)
        : event.key === "ArrowUp" ? (previous >= 0 ? changes[previous].start : 0) : null;
      if (target !== null) { event.preventDefault(); onJump(target); }
    }}>
    <span className="file-diff-overview-window" style={{
      top: `${first / rows.length * 100}%`,
      height: `${(last - first + 1) / rows.length * 100}%`,
    }} />
    {markers.map((marker) => <span key={`${marker.start}:${marker.kind}`}
      className={`file-diff-marker is-${marker.kind}`} style={{
        top: `calc(${marker.start / rows.length * 100}% - 1px)`,
        height: `${(marker.end - marker.start) / rows.length * 100}%`,
      }} />)}
  </div>;
}
