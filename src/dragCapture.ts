/**
 * The teardown both drag surfaces run when a pointer drag ends.
 *
 * Splitter and FilerColumnResizer each carried their own copy of this - the
 * retire-before-release ordering, the window-fallback vs lostpointercapture
 * race, flush-on-release vs cancel-on-interrupt - including a two-line comment
 * verbatim. This is the subtlest correctness surface in the UI, and a fix to
 * one copy had to be ported to the other by hand.
 */
interface ReleasableDrag {
  target: HTMLDivElement;
  pointerId: number;
}

/**
 * Release the pointer and settle the frame batch. `label` names the surface in
 * the one warning this can log, so a reader of the console knows which drag
 * failed to release.
 */
export function releaseDrag(
  active: ReleasableDrag | null,
  commit: boolean,
  batch: { flush(): void; cancel(): void },
  label: string,
): void {
  try {
    if (active?.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
  } catch (error) {
    // The WebView may already have removed the pointer. Do not let that
    // leave the global resize cursor or a queued resize alive.
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      console.warn(`Failed to release ${label} pointer capture`, error);
    }
  } finally {
    // Only a normal release commits the final frame. Interruptions discard
    // pending work, without undoing sizes already applied in earlier frames.
    if (active && commit) batch.flush();
    else batch.cancel();
  }
}
