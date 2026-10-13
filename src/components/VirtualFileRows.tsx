import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const VIRTUAL_THRESHOLD = 200;
const OVERSCAN = 6;

/** The visible interval, with a few rows on either side for smooth scrolling. */
export function fileRowRange(
  count: number, top: number, height: number, pitch: number,
) {
  top = Math.min(top, Math.max(0, count * pitch - height));
  const start = Math.max(0, Math.min(count, Math.floor(Math.max(0, top) / pitch) - OVERSCAN));
  const end = Math.min(count, Math.max(start, Math.ceil(Math.max(0, top + height) / pitch) + OVERSCAN));
  return { start, end };
}

/**
 * Lives inside the existing scroll/drop container. Only the row DOM is
 * windowed; sorting, selection and file operations keep the complete listing.
 * A captured drag source stays mounted even when scrolled out of view.
 */
export function VirtualFileRows<T extends { path: string }>({
  entries,
  rowHeight,
  resetKey,
  children,
}: {
  entries: readonly T[];
  rowHeight: number;
  resetKey: string;
  children: (entry: T, index: number) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [captured, setCaptured] = useState<string | null>(null);
  const capturedIndex = useMemo(
    () => captured === null ? -1 : entries.findIndex((entry) => entry.path === captured),
    [entries, captured],
  );
  const measureRef = useRef<() => void>(() => {});
  const virtual = entries.length > VIRTUAL_THRESHOLD;

  useLayoutEffect(() => {
    const element = root.current!;
    const scroller = element.parentElement!;
    let frame: number | null = null;
    const measure = () => {
      const offset = element.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop;
      const next = { top: scroller.scrollTop - offset, height: scroller.clientHeight };
      setViewport((old) => old.top === next.top && old.height === next.height ? old : next);
    };
    measureRef.current = measure;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(element);
    scroller.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, []);

  useLayoutEffect(() => {
    root.current!.parentElement!.scrollTop = 0;
    setCaptured(null);
  }, [resetKey]);
  // Also remeasure inline create/error messages above the rows and font changes.
  useLayoutEffect(() => { measureRef.current(); });

  const { start, end } = virtual
    ? fileRowRange(entries.length, viewport.top, viewport.height, rowHeight)
    : { start: 0, end: entries.length };
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  if (virtual && capturedIndex >= 0 && (capturedIndex < start || capturedIndex >= end)) {
    indices.push(capturedIndex);
  }
  const style: CSSProperties | undefined = virtual
    ? { position: "relative", height: entries.length * rowHeight, overflowAnchor: "none" }
    : undefined;
  return (
    <div ref={root} style={style} className="virtual-file-rows"
      onGotPointerCapture={(event) => {
        const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-file-path]");
        if (slot) setCaptured(slot.dataset.filePath ?? null);
      }}
      onLostPointerCapture={() => setCaptured(null)}
    >
      {indices.map((index) => (
        <div key={entries[index].path} data-file-path={entries[index].path}
          style={virtual ? { position: "absolute", top: index * rowHeight, width: "100%", height: rowHeight } : undefined}
        >
          {children(entries[index], index)}
        </div>
      ))}
    </div>
  );
}
