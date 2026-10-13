/**
 * Folds a burst of numeric deltas into one `apply` per animation frame —
 * for drag handlers whose application (a React state update and the layout
 * it reflows) is too expensive to run per event. Pointer moves arrive at
 * the mouse's report rate (125–1000 Hz), far above the display's; summing
 * the deltas between two frames keeps the applied movement exactly what
 * the per-move updates would have produced.
 *
 * `flush` applies whatever is pending right away — a drag's final frame
 * must land with the pointer-up, not one rAF later.
 */
export function createFrameBatch(
  apply: (delta: number) => void,
): {
  /** Accumulates `delta`; the scheduled frame applies the sum once. */
  push: (delta: number) => void;
  /** Cancels the scheduled frame and applies anything pending now. */
  flush: () => void;
  /** Drops anything pending without applying it. */
  cancel: () => void;
} {
  let frame: number | null = null;
  let pending = 0;
  const run = () => {
    frame = null;
    const delta = pending;
    pending = 0;
    if (delta !== 0) apply(delta);
  };
  return {
    push(delta) {
      pending += delta;
      if (frame === null) frame = requestAnimationFrame(run);
    },
    flush() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      const delta = pending;
      pending = 0;
      if (delta !== 0) apply(delta);
    },
    cancel() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      pending = 0;
    },
  };
}
