import { useCallback, useEffect, useRef, useState } from "react";

import { createFrameBatch } from "../frameBatch";

interface Props {
  orientation: "vertical" | "horizontal";
  /** Receives the pointer delta in pixels since the last application. */
  onResize: (delta: number) => void;
}

export function Splitter({ orientation, onResize }: Props) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  // Every onResize is a React state update that re-renders and reflows the
  // layout around the splitter, so the deltas between two frames are folded
  // into one application; see frameBatch.ts. The latest `onResize` is read
  // through a ref because its closure (which way a panel clamps, whether the
  // Sender expands) changes as the drag reshapes the app.
  const latest = useRef(onResize);
  latest.current = onResize;
  const batch = useRef<ReturnType<typeof createFrameBatch> | null>(null);
  if (batch.current === null) {
    batch.current = createFrameBatch((delta) => latest.current(delta));
  }
  useEffect(() => batch.current!.cancel, []);

  const handleDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      last.current = orientation === "vertical" ? event.clientX : event.clientY;
      setDragging(true);
    },
    [orientation],
  );

  const handleMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const current =
        orientation === "vertical" ? event.clientX : event.clientY;
      const delta = current - last.current;
      if (delta !== 0) {
        last.current = current;
        batch.current!.push(delta);
      }
    },
    [dragging, orientation],
  );

  const handleUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // The drag's final delta lands now, with the pointer-up, rather than
      // one frame later.
      batch.current!.flush();
      // A pointercancel can arrive for a pointer already gone; releasing a
      // capture it no longer holds would throw and skip the state reset.
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragging(false);
    },
    [],
  );

  return (
    <div
      className={`splitter is-${orientation}${dragging ? " is-dragging" : ""}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    />
  );
}
