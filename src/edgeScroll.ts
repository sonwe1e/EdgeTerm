/**
 * Auto-scroll for the dual-pane pointer drag: a drag held near a list's top
 * or bottom edge keeps that list scrolling until the pointer moves away or
 * the drop lands. Without it, a long list cannot be scrolled while an entry
 * is being dragged over it — the drag owns the pointer, so the wheel is not
 * an alternative.
 */

export interface EdgeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The per-frame scroll delta for a pointer at (`x`, `y`) over a container
 * rectangle: negative scrolls up near the top edge, positive down near the
 * bottom, faster the closer the pointer is, and 0 anywhere else. A pointer
 * slightly outside the rectangle still counts, the way drag-and-drop
 * implementations treat the edge band as part of the list.
 */
export function edgeScrollStep(
  rect: EdgeRect,
  x: number,
  y: number,
  edge = 36,
  maxStep = 14,
): number {
  if (x < rect.left || x > rect.right) return 0;
  // Measured from each boundary, positive towards the inside. A pointer up
  // to `edge` beyond the boundary still counts — the way drag-and-drop
  // treats the edge band as part of the list — but one further away does
  // not, so a drag over another pane never scrolls this list.
  const fromTop = y - rect.top;
  const fromBottom = rect.bottom - y;
  const up = fromTop > -edge ? clamp01((edge - fromTop) / edge) : 0;
  const down = fromBottom > -edge ? clamp01((edge - fromBottom) / edge) : 0;
  if (up <= 0 && down <= 0) return 0;
  if (up >= down) return -Math.round(maxStep * up);
  return Math.round(maxStep * down);
}

/**
 * Tracks the pointer across frames and scrolls whichever of `containers`
 * reports a non-zero step. The loop keeps itself alive only while a pointer
 * stays near an edge, so a motionless pointer far from the edges costs
 * nothing.
 */
export function createDragAutoScroll(
  containers: () => readonly HTMLElement[],
  edge = 36,
  maxStep = 14,
): {
  update: (x: number, y: number) => void;
  stop: () => void;
} {
  let x = 0;
  let y = 0;
  let live = false;
  let frame: number | null = null;
  const tick = () => {
    frame = null;
    if (!live) return;
    let near = false;
    for (const element of containers()) {
      const step = edgeScrollStep(
        element.getBoundingClientRect(),
        x,
        y,
        edge,
        maxStep,
      );
      if (step !== 0) {
        element.scrollTop += step;
        near = true;
      }
    }
    if (near) frame = requestAnimationFrame(tick);
  };
  return {
    update(nextX, nextY) {
      x = nextX;
      y = nextY;
      live = true;
      if (frame === null) frame = requestAnimationFrame(tick);
    },
    stop() {
      live = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
