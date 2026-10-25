import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffRow } from "../api";
import { diffRowAt, estimateDiffHeight } from "../fileDiffLayout";
import { useStableCallback } from "../useStableCallback";

/** Variable row heights keep paired wrapped lines aligned while bounding row DOM. */
export function useDiffViewport(rows: readonly DiffRow[], wrap: boolean) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 1000 });
  const [revision, setRevision] = useState(0);
  const measured = useMemo(() => new Map<number, number>(), [rows, wrap, viewport.width]);
  const restore = useRef<{ index: number; within: number } | null>(null);
  const offsets = useMemo(() => {
    const positions = [0];
    for (let index = 0; index < rows.length; index++) {
      positions.push(
        positions[index] +
          (measured.get(index) ?? estimateDiffHeight(rows[index], viewport.width, wrap)),
      );
    }
    return positions;
  }, [rows, wrap, viewport.width, measured, revision]);
  const total = offsets[rows.length];
  const layout = useRef({ measured, offsets, top: viewport.top });
  const top = Math.min(viewport.top, Math.max(0, total - viewport.height));
  const first = diffRowAt(offsets, top);
  const last = diffRowAt(offsets, top + viewport.height);
  const start = Math.max(0, first - 4);
  const end = Math.min(rows.length, last + 5);

  const readViewport = useStableCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const next = {
      top: element.scrollTop,
      height: element.clientHeight,
      width: element.clientWidth,
    };
    setViewport((old) =>
      old.top === next.top && old.height === next.height && old.width === next.width ? old : next,
    );
  });
  const measureRows = useStableCallback(() => {
    const element = scroller.current;
    if (!element) return;
    let changed = false;
    for (const row of element.querySelectorAll<HTMLElement>("[data-diff-index]")) {
      const index = Number(row.dataset.diffIndex);
      const height = row.getBoundingClientRect().height;
      const expected = measured.get(index) ?? offsets[index + 1] - offsets[index];
      if (height > 0 && Math.abs(height - expected) > 0.5) {
        measured.set(index, height);
        changed = true;
      }
    }
    if (changed) {
      const index = diffRowAt(offsets, element.scrollTop);
      restore.current = { index, within: element.scrollTop - offsets[index] };
      setRevision((value) => value + 1);
    }
  });
  useLayoutEffect(() => {
    const element = scroller.current!;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        readViewport();
      });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    element.addEventListener("scroll", schedule, { passive: true });
    readViewport();
    return () => {
      resize.disconnect();
      element.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [readViewport]);

  // Restore the same logical row after measurements above it change. Browser
  // scroll anchoring is disabled because virtual rows are repeatedly replaced.
  useLayoutEffect(() => {
    const element = scroller.current!;
    if (layout.current.measured !== measured) {
      const previous = layout.current;
      const index = diffRowAt(previous.offsets, previous.top);
      restore.current = { index, within: previous.top - previous.offsets[index] };
    }
    if (restore.current) {
      const { index, within } = restore.current;
      const target = Math.min(index, rows.length - 1);
      element.scrollTop =
        offsets[target] + Math.min(within, offsets[target + 1] - offsets[target] - 1);
      restore.current = null;
      readViewport();
    }
    layout.current = { measured, offsets, top: element.scrollTop };
    measureRows();
  }, [offsets, start, end, rows.length, measured, readViewport, viewport.top, measureRows]);

  useLayoutEffect(() => {
    // Font loading and preference changes can resize text without changing the
    // scroller's width. Observe the mounted rows as well as its viewport.
    const resize = new ResizeObserver(measureRows);
    for (const row of scroller.current!.querySelectorAll("[data-diff-index]")) resize.observe(row);
    return () => resize.disconnect();
  }, [start, end, measured, measureRows]);

  useLayoutEffect(() => {
    if (wrap) scroller.current!.scrollLeft = 0;
  }, [wrap]);

  const jump = (index: number) => {
    const element = scroller.current!;
    const target = Math.max(0, Math.min(index, rows.length - 1));
    element.scrollTop = offsets[target];
    readViewport();
  };
  return { scroller, offsets, total, top, first, last, start, end, jump, viewport };
}
