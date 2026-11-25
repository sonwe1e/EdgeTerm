import { useEffect, useRef, type RefObject } from "react";

/**
 * Returns focus to the status-bar trigger button that owns a popover.
 * Prefers the explicit `button.status-item` trigger and falls back to the first
 * button inside the wrapper for minimal test harnesses.
 */
export function focusPopoverTrigger(root: RefObject<HTMLElement | null>) {
  const trigger = root.current?.querySelector<HTMLButtonElement>("button.status-item");
  (trigger ?? root.current?.querySelector<HTMLButtonElement>("button"))?.focus();
}

/** Status popovers close when focus/pointer moves away or Escape is pressed. */
export function usePopoverDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
) {
  const dismiss = useRef(close);
  dismiss.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target)) return;
      // A pointerdown on non-interactive content inside the popover (a
      // label's span, a caption, a job name) makes the browser focus the
      // nearest focusable ancestor — the status bar, which is tabIndex=-1 and
      // contains this popover. That focus move is a side effect of a click
      // that was already inside, not the user leaving: treating it as
      // "outside" closed the panel on every such click. A real outside
      // pointerdown is rejected above this exception, so only focusin gets it.
      if (
        event.type === "focusin" &&
        target !== document.body &&
        target !== document.documentElement &&
        target.contains(root.current)
      ) {
        return;
      }
      dismiss.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      dismiss.current();
      focusPopoverTrigger(root);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, root]);
}
