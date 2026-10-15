import {
  useCallback,
  useEffect,
  useRef,
  type AnimationEvent as ReactAnimationEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { endDialogAttention, requestDialogAttention } from "./dialogAttention";
import { useDialogDrag } from "./useDialogDrag";

interface Props {
  /** Controlled by the caller's conditional render; true renders the modal. */
  open: boolean;
  /**
   * The single close exit: Escape on the top-layer dialog (native cancel,
   * or the fallback handler when showModal is unavailable) and a backdrop
   * press that starts and ends outside the content box both come through
   * here. Every occurrence is reported — a caller that defers closing (a
   * busy submit) simply gets the next Escape/backdrop as a fresh request.
   * Callers keep their own semantics: confirm and cancel stay separate
   * buttons.
   */
  onClose: () => void;
  /** A backdrop press closes (confirmations) or only flashes (forms). */
  dismissable?: boolean;
  /** The dialog-header element a drag handle is attached to. */
  title?: ReactNode;
  /** Makes the header drag the content box around (useDialogDrag). */
  draggable?: boolean;
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  /** Extra class on the inner content box (confirm-dialog, …). */
  contentClassName?: string;
  /**
   * Key handler for keys aimed at this dialog, invoked from the dialog's
   * own key listener before the event is stopped from bubbling further —
   * so no dialog key can reach window-level shortcut listeners, and a
   * dialog underneath can never answer the same keystroke. Confirmation
   * dialogs keep their Enter-means-confirm contract here; Escape on the
   * native path stays on the cancel event.
   */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDialogElement>) => void;
  children?: ReactNode;
}

/**
 * Fallback dialogs in open order (showModal unavailable): the last one is
 * the topmost keyboard target, and closing it returns focus to the one
 * beneath.
 */
const fallbackStack: HTMLDialogElement[] = [];

/**
 * The application's modal dialog primitive on the native
 * `dialog.showModal()`: the browser owns the top layer, the background's
 * inertness, focus containment and Tab cycling, and delivers Escape as the
 * `cancel` event — which only the top-layer dialog receives, so nested
 * dialogs close one at a time by construction. Keys aimed at the dialog are
 * stopped at the dialog element (they cannot reach window-level listeners),
 * and backdrop presses are resolved by a pointer sequence (press and
 * release both outside the content box), so a drag that starts inside and
 * ends outside is never a dismissal.
 *
 * When `showModal` is unavailable the primitive says so instead of
 * pretending: the dialog opens non-natively with its own dim, a Tab cycle
 * that stays inside the content box, Escape handling and topmost-focus
 * management for stacked fallback dialogs. The background is then visually
 * dimmed but not inert — a declared platform boundary, verified by the
 * forced-fallback contracts.
 *
 * Lifecycle is idempotent under StrictMode's double effects: the open
 * action runs only on a closed dialog, the close action only on an open
 * one, and internally driven closes do not call `onClose`.
 */
export function ModalDialog({
  open,
  onClose,
  dismissable = true,
  title,
  draggable = false,
  role = "dialog",
  labelledBy,
  contentClassName,
  onKeyDown,
  children,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Set while a close is driven from this component (the open/closed effect
  // or cleanup), so the element's own `close` event does not report it back
  // as a user dismissal.
  const closingInternally = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /**
   * The backdrop press that started outside; paired with its release.
   */
  const outsidePress = useRef<{ x: number; y: number } | null>(null);
  /**
   * How THIS open cycle was performed: native showModal (close() available)
   * or the fallback open attribute (close() may be deleted by the same
   * platforms that lack showModal). The cleanup closes accordingly.
   */
  const openedNatively = useRef(false);
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const dismissableRef = useRef(dismissable);
  dismissableRef.current = dismissable;
  /**
   * The focusable that had focus before this dialog opened, captured in the
   * element ref callback — before showModal's autofocus can move focus — so
   * the last close can hand focus back to the real opener.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  const attachDialogRef = useCallback((element: HTMLDialogElement | null) => {
    if (element) {
      // Capture before any effect (and before showModal's autofocus) moves
      // focus into the dialog.
      openerRef.current = document.activeElement as HTMLElement | null;
    }
    dialogRef.current = element;
  }, []);
  const { dialogRef: dragTargetRef, handleProps } = useDialogDrag<HTMLDivElement>();
  const attachContentBox = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    dragTargetRef.current = element;
  }, [dragTargetRef]);

  const supportsNativeModal = () =>
    typeof dialogRef.current?.showModal === "function";

  const focusContent = () => {
    // The show-modal focus algorithm honours autofocus; the fallback starts
    // on the content box so Tab cycling has an anchor.
    if (!supportsNativeModal()) contentRef.current?.focus();
  };

  // --- fallback focus ownership ------------------------------------------------
  // Without the top layer nothing stops a programmatic (or click-driven)
  // focus move into the background, so the fallback re-anchors focus to the
  // topmost dialog whenever it lands elsewhere. Native dialogs don't need
  // this: inertness plus the top layer make such moves impossible.
  useEffect(() => {
    if (!open || supportsNativeModal()) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onFocusIn = (event: FocusEvent) => {
      if (dialog.contains(event.target as Node)) return;
      if (fallbackStack[fallbackStack.length - 1] !== dialog) return;
      focusContent();
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, [open]);

  // --- close/cleanup -----------------------------------------------------------
  // On the last close, focus returns to the real opener (captured before
  // showModal's autofocus ran); a stacked fallback beneath takes it instead.
  const restoreFocusAfterClose = () => {
    const beneath = fallbackStack[fallbackStack.length - 1];
    if (beneath) beneath.focus({ preventScroll: true });
    else openerRef.current?.focus({ preventScroll: true });
  };

  /**
   * Closes THIS open cycle the way it was opened: native cycles use
   * close(), fallback cycles (whose platforms may have deleted close along
   * with showModal) drop the open attribute. Then the fallback bookkeeping
   * and the opener/stack focus restore run unconditionally.
   */
  const closeOpenedDialog = (dialog: HTMLDialogElement) => {
    if (openedNatively.current) {
      if (dialog.open) {
        closingInternally.current = true;
        dialog.close();
      }
    } else if (dialog.hasAttribute("open")) {
      dialog.removeAttribute("open");
    }
    const index = fallbackStack.indexOf(dialog);
    if (index !== -1) fallbackStack.splice(index, 1);
    restoreFocusAfterClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) return;
    if (supportsNativeModal()) {
      openedNatively.current = true;
      if (!dialog.open) dialog.showModal();
    } else {
      openedNatively.current = false;
      if (!dialog.hasAttribute("open")) dialog.setAttribute("open", "");
      dialog.classList.add("is-fallback");
      if (!fallbackStack.includes(dialog)) fallbackStack.push(dialog);
      focusContent();
    }
    return () => {
      closeOpenedDialog(dialog);
      dialog.classList.remove("is-fallback");
    };
  }, [open]);

  // --- close/cancel events ------------------------------------------------------
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const notify = () => onCloseRef.current();
    const onDialogClose = () => {
      if (closingInternally.current) {
        closingInternally.current = false;
        return;
      }
      notify();
    };
    // Native path only: the fallback has no cancel event, its Escape is
    // handled by the dialog key listener below.
    const onDialogCancel = (event: Event) => {
      event.preventDefault();
      notify();
    };
    dialog.addEventListener("close", onDialogClose);
    dialog.addEventListener("cancel", onDialogCancel);
    return () => {
      dialog.removeEventListener("close", onDialogClose);
      dialog.removeEventListener("cancel", onDialogCancel);
    };
  }, []);

  // --- keyboard boundary ------------------------------------------------------
  // The bubble boundary lives on the dialog's React onKeyDown: handlers on
  // children (inputs, sub-menus, forms) run first, then this one stops the
  // event so nothing — window-level shortcut listeners included — answers a
  // key that was aimed at the dialog. Tab containment runs on BOTH paths:
  // Edge 155's native modal lets one Tab from the last control land on body
  // before re-entering (verified against a bare showModal dialog), which
  // violates the top-layer boundary this primitive must guarantee. The
  // fallback's Escape/Tab handling also lives here; Escape only ever
  // *requests* the close (the controlled `open` flip performs it), so a
  // caller deferring the close keeps its state consistent.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    onKeyDownRef.current?.(event as unknown as ReactKeyboardEvent<HTMLDialogElement>);
    // Native path: stop the key here so window-level shortcut listeners
    // never see a dialog key, and keep Tab cycling inside the content box
    // (Edge 155 lets one Tab from the last control land on body). The
    // fallback path's boundary is the window capture listener below,
    // because without the top layer the key event may not even pass
    // through this dialog.
    event.stopPropagation();
    if (event.key === "Tab" && !event.defaultPrevented) {
      containTab(event.nativeEvent, dialogRef.current!);
    }
  };

  const containTab = (event: KeyboardEvent, dialog: HTMLDialogElement) => {
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  // --- fallback keyboard boundary ------------------------------------------------
  // Without showModal there is no top layer, so the key event for a click
  // into the background (or an unfocused page) may never pass through this
  // dialog — a dialog-level listener cannot be the boundary. While a
  // fallback dialog of this primitive is topmost, a capture-phase window
  // listener owns Escape, Tab containment and the bubbling cut. Removed as
  // soon as no fallback from this primitive remains; native dialogs never
  // install it (their top layer already does this).
  useEffect(() => {
    if (!open || supportsNativeModal()) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const isTopmost = () => fallbackStack[fallbackStack.length - 1] === dialog;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      onKeyDownRef.current?.(event as unknown as ReactKeyboardEvent<HTMLDialogElement>);
      // Owned: nothing else (App shortcuts, background listeners) may react.
      event.stopPropagation();
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && isTopmost()) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") containTab(event, dialog);
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [open]);

  // --- backdrop press sequence ----------------------------------------------
  const onBackdropPointerDown = (event: ReactPointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = contentRef.current?.getBoundingClientRect();
    const inside = rect &&
      event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (inside) {
      outsidePress.current = null;
      return;
    }
    outsidePress.current = { x: event.clientX, y: event.clientY };
  };

  const onBackdropPointerUp = (event: ReactPointerEvent<HTMLDialogElement>) => {
    const started = outsidePress.current;
    outsidePress.current = null;
    if (!started || event.target !== event.currentTarget) return;
    const rect = contentRef.current?.getBoundingClientRect();
    const inside = rect &&
      event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (inside) return; // pressed outside, released inside: not a dismissal
    if (dismissableRef.current) {
      onCloseRef.current();
    } else {
      requestDialogAttention(contentRef.current);
    }
  };

  // A plain mousedown inside the dialog must not close it; the backdrop
  // press sequence above handles the outside case.
  const onContentMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const onContentAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>) => {
    endDialogAttention(event);
  };

  return (
    <dialog
      ref={attachDialogRef}
      className="dialog-backdrop"
      role={role}
      aria-labelledby={labelledBy}
      onKeyDown={handleKeyDown}
      onPointerDown={onBackdropPointerDown}
      onPointerUp={onBackdropPointerUp}
    >
      <div
        ref={attachContentBox}
        className={`dialog${contentClassName ? ` ${contentClassName}` : ""}`}
        tabIndex={-1}
        onMouseDown={onContentMouseDown}
        onAnimationEnd={onContentAnimationEnd}
      >
        {title !== undefined && (
          <div
            className="dialog-header"
            id={labelledBy}
            {...(draggable ? handleProps : undefined)}
          >
            {title}
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}
