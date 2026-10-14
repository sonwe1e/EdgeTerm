import { useEffect, useRef, type RefObject } from "react";

/** Status popovers close when focus/pointer moves away or Escape is pressed. */
export function usePopoverDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>) {
  const dismiss = useRef(close);
  dismiss.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); dismiss.current(); root.current?.querySelector("button")?.focus();
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
