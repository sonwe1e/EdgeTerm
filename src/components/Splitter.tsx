import { useCallback, useEffect, useRef, useState } from "react";

import { createFrameBatch } from "../frameBatch";
import { useT } from "../useT";

/** One arrow keypress moves the separator by this many pixels. */
const KEY_STEP = 8;
/** Shift turns a keypress into a coarse adjustment. */
const KEY_STEP_LARGE = 32;

interface Props {
  orientation: "vertical" | "horizontal";
  /** Receives the pointer delta in pixels since the last application. */
  onResize: (delta: number) => void;
  /**
   * Called once per pointer drag, after capture. Lets the owner snapshot
   * whatever the deltas will move — a base size measured now, not on every
   * frame. Keyboard resizing never triggers it.
   */
  onDragStart?: () => void;
  /**
   * Called once when a pointer drag ends, after the final frame was flushed
   * (committed) or dropped (interrupted). `committed` is true only for a
   * normal release. An interruption has already applied its earlier frames,
   * so the owner keeps what was shown and uses this to make its state match
   * the DOM. Not called for keyboard resizing or an unmount.
   */
  onEnd?: (committed: boolean) => void;
}

interface Drag {
  target: HTMLDivElement;
  pointerId: number;
  last: number;
  removeListeners: () => void;
}

export function Splitter({ orientation, onResize, onDragStart, onEnd }: Props) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);

  // Every onResize is a React state update that re-renders and reflows the
  // layout around the splitter, so the deltas between two frames are folded
  // into one application; see frameBatch.ts. The latest `onResize` is read
  // through a ref because its closure (which way a panel clamps, whether the
  // Sender expands) changes as the drag reshapes the app. The drag-lifetime
  // callbacks ride the same refs: they outlive one render too.
  const latest = useRef(onResize);
  latest.current = onResize;
  const began = useRef(onDragStart);
  began.current = onDragStart;
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const batch = useRef<ReturnType<typeof createFrameBatch> | null>(null);
  if (batch.current === null) {
    batch.current = createFrameBatch((delta) => latest.current(delta));
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
        console.warn("Failed to release splitter pointer capture", error);
      }
    } finally {
      // Only a normal release commits the final frame. Interruptions discard
      // pending work, without undoing sizes already applied in earlier frames.
      if (active && commit) batch.current!.flush();
      else batch.current!.cancel();
    }
    // After the flush, so the owner's commit sees the width the release just
    // applied. Unmounts (updateState=false) end silently: there is no state
    // left to reconcile.
    if (active && updateState) ended.current?.(commit);
  }, []);

  useEffect(() => {
    setDragging(false);
    return () => finish(false, false);
  }, [finish, orientation]);

  const handleDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      const target = event.currentTarget;
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
      const visibility = () => {
        if (document.visibilityState === "hidden") cancel();
      };
      drag.current = {
        target,
        pointerId: event.pointerId,
        last: orientation === "vertical" ? event.clientX : event.clientY,
        removeListeners: () => {
          window.removeEventListener("pointerup", endPointer, true);
          window.removeEventListener("pointercancel", endPointer, true);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", keydown, true);
          document.removeEventListener("visibilitychange", visibility);
        },
      };
      // Listen immediately, not after a render. A release outside the splitter
      // must still terminate the drag if the WebView interrupts capture.
      window.addEventListener("pointerup", endPointer, true);
      window.addEventListener("pointercancel", endPointer, true);
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", keydown, true);
      document.addEventListener("visibilitychange", visibility);
      began.current?.();
      setDragging(true);
    },
    [finish, orientation],
  );

  const handleMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finish(false);
        return;
      }
      const current = orientation === "vertical" ? event.clientX : event.clientY;
      const delta = current - active.last;
      if (delta !== 0) {
        active.last = current;
        batch.current!.push(delta);
      }
    },
    [finish, orientation],
  );

  const handleLostCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerId === drag.current?.pointerId) finish(false);
    },
    [finish],
  );

  // Keyboard resizing goes through the same frame batch as the pointer, so a
  // burst of auto-repeat is folded into one state update per frame. The press
  // is flushed immediately: an arrow key must land without waiting a frame.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (drag.current) return;
      const before = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
      const after = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
      if (event.key !== before && event.key !== after) return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      batch.current!.push(event.key === after ? step : -step);
      batch.current!.flush();
    },
    [orientation],
  );

  return (
    <div
      className={`splitter is-${orientation}${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={t("splitter.resize")}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onLostPointerCapture={handleLostCapture}
    />
  );
}
