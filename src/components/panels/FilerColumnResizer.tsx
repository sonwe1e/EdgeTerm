import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { createFrameBatch } from "../../frameBatch";

/** One arrow keypress moves the boundary by this many pixels. */
const KEY_STEP = 8;
/** Shift turns a keypress into a coarse adjustment. */
const KEY_STEP_LARGE = 32;

interface Drag {
  pointerId: number;
  target: HTMLDivElement;
  /** Pointer position at the last applied move, so deltas stay exact. */
  last: number;
  /** The column's width when the drag began, measured from its grid cell. */
  startWidth: number;
  /** Deltas applied so far; the reported width is `startWidth + total`. */
  total: number;
  removeListeners: () => void;
}

/**
 * The drag handle on the left edge of one Filer column caption.
 *
 * It reports the owning cell's width at the moment the adjustment began and
 * the pointer's accumulated movement, so the panel can decide what that
 * movement means: the handle on the size column's left edge trades room with
 * the names, while the one on the modified column's left edge trades room
 * with the size column. Reporting the raw pair rather than a finished width is
 * what lets one handle serve both trades.
 *
 * The direction follows the convention every file manager uses: dragging the
 * boundary to the right widens the column on its *left*, so the column this
 * handle owns — the one to the right of the boundary — gives up room.
 *
 * The handle straddles the boundary between two grid tracks rather than
 * occupying a track of its own, so the caption row and the rows below it stay
 * on one grid and no space is spent on the handle itself.
 *
 * Pointer capture, the frame batch and every termination path mirror the
 * Splitter: a release outside the handle, a lost capture, a blur, Escape and
 * an unmount all end the drag, and only a normal release commits the last
 * frame.
 */
export function FilerColumnResizer({
  label,
  onStart,
  onResize,
}: {
  label: string;
  /**
   * Called when an adjustment begins — once per pointer drag, and once per
   * keypress. The panel uses it to measure the *other* column the boundary
   * trades with, which this handle cannot see from its own cell.
   */
  onStart?: () => void;
  /** The owning cell's width when the adjustment began, and the movement since. */
  onResize: (startWidth: number, delta: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  // What the frame batch applies. `finish` retires `drag.current` before it
  // flushes the final frame — the window fallback and lostpointercapture may
  // both arrive for one pointer — so the batch may not read that ref to find
  // the drag it is still allowed to apply: a release landing before the
  // scheduled frame would drop the pending movement. This ref holds the same
  // drag until the flush or cancel has settled, and only then is cleared.
  const live = useRef<Drag | null>(null);

  // The latest callbacks are read through refs: the panel's closures change as
  // the drag reshapes the listing, and the batch outlives one render.
  const latest = useRef(onResize);
  latest.current = onResize;
  const start = useRef(onStart);
  start.current = onStart;
  const batch = useRef<ReturnType<typeof createFrameBatch> | null>(null);
  if (batch.current === null) {
    batch.current = createFrameBatch((delta) => {
      const active = live.current;
      if (!active) return;
      active.total += delta;
      latest.current(active.startWidth, active.total);
    });
  }

  const finish = useCallback((commit: boolean, updateState = true) => {
    const active = drag.current;
    // Retire the drag before releasing capture: lostpointercapture and the
    // window fallback may both arrive for the same pointer.
    drag.current = null;
    active?.removeListeners();
    if (updateState) setDragging(false);
    try {
      if (active?.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch (error) {
      // The WebView may already have removed the pointer. Do not let that
      // leave the global resize cursor or a queued resize alive.
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        console.warn("Failed to release column resizer pointer capture", error);
      }
    } finally {
      // Only a normal release commits the final frame. Interruptions discard
      // pending work, without undoing widths already applied in earlier frames.
      if (active && commit) batch.current!.flush();
      else batch.current!.cancel();
      live.current = null;
    }
  }, []);

  useEffect(() => {
    return () => finish(false, false);
  }, [finish]);

  const handleDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      // The handle is a sibling of the caption button, so a press on it never
      // reaches the button's click; stopping it here keeps the cell and the
      // columns row from treating the press as a sort.
      event.stopPropagation();
      const target = event.currentTarget;
      const cell = target.parentElement;
      if (!cell) return;
      try {
        target.setPointerCapture(event.pointerId);
      } catch (error) {
        // A pointer that vanished before capture must not start a drag.
        if (error instanceof DOMException && error.name === "NotFoundError") return;
        throw error;
      }
      const endPointer = (e: PointerEvent) => {
        if (e.pointerId === drag.current?.pointerId) finish(e.type === "pointerup");
      };
      const cancel = () => finish(false);
      const keydown = (e: KeyboardEvent) => {
        if (e.key === "Escape") cancel();
      };
      drag.current = {
        pointerId: event.pointerId,
        target,
        last: event.clientX,
        startWidth: cell.getBoundingClientRect().width,
        total: 0,
        removeListeners: () => {
          window.removeEventListener("pointerup", endPointer, true);
          window.removeEventListener("pointercancel", endPointer, true);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", keydown, true);
        },
      };
      live.current = drag.current;
      // Listen immediately, not after a render. A release outside the handle
      // must still terminate the drag if the WebView interrupts capture.
      window.addEventListener("pointerup", endPointer, true);
      window.addEventListener("pointercancel", endPointer, true);
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", keydown, true);
      start.current?.();
      setDragging(true);
    },
    [finish],
  );

  const handleMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finish(false);
        return;
      }
      const delta = event.clientX - active.last;
      if (delta !== 0) {
        active.last = event.clientX;
        batch.current!.push(delta);
      }
    },
    [finish],
  );

  const handleLostCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerId === drag.current?.pointerId) finish(false);
    },
    [finish],
  );

  // Keyboard resizing reads the live width rather than a drag's start value,
  // so repeated presses compound from wherever the column currently sits. The
  // sign matches the pointer: ArrowRight narrows this column, because the
  // column to its left is the one that grows.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (drag.current) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const cell = event.currentTarget.parentElement;
      if (!cell) return;
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      // A keypress is its own adjustment, so the panel gets the same chance to
      // measure the trading partner that a pointer drag gives it.
      start.current?.();
      latest.current(
        cell.getBoundingClientRect().width,
        event.key === "ArrowRight" ? step : -step,
      );
    },
    [],
  );

  return (
    <div
      className={`filer-col-resize${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onLostPointerCapture={handleLostCapture}
    />
  );
}
