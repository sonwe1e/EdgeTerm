import { useEffect, useRef, type RefObject } from "react";

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
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss.current();
      root.current?.querySelector("button")?.focus();
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
