/**
 * Runs `apply` at most once per animation frame, with the latest value
 * scheduled — for work that must track a moving pointer but is too
 * expensive per event, like a drag's drop-target hit test
 * (`document.elementFromPoint` forces a layout when the DOM is dirty).
 * `flush` applies a pending value immediately and `cancel` drops it, so a
 * gesture that ends can neither lag a frame behind nor fire after it is
 * over.
 */
export function createFrameGate<T>(
  apply: (value: T) => void,
): {
  /** Records `value` as the one the next frame will apply. */
  schedule: (value: T) => void;
  /** Cancels the scheduled frame and applies anything pending now. */
  flush: () => void;
  /** Drops anything pending without applying it. */
  cancel: () => void;
} {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const run = () => {
    frame = null;
    const next = pending;
    pending = null;
    if (next !== null) apply(next.value);
  };
  return {
    schedule(value) {
      pending = { value };
      if (frame === null) frame = requestAnimationFrame(run);
    },
    flush() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      const next = pending;
      pending = null;
      if (next !== null) apply(next.value);
    },
    cancel() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      pending = null;
    },
  };
}
