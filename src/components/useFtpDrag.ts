import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createDragAutoScroll } from "../edgeScroll";
import { createFrameGate } from "../frameGate";
import { dropAction, type DraggedEntry, type DropTarget, type PaneSide } from "../paneDrop";
import type { FileEntry } from "../types";
import { useStableCallback } from "../useStableCallback";
import { DRAG_THRESHOLD } from "./ftpPresentation";

interface Options {
  transferring: boolean;
  runUpload: (incoming: FileEntry, destDir: string) => Promise<void>;
  runDownload: (incoming: FileEntry, destDir: string) => Promise<void>;
  active: boolean;
}

export function useFtpDrag({ transferring, runUpload, runDownload, active }: Options) {
  // The entry a pointer drag is carrying, plus the press that may become
  // one. Refs are what the gesture handlers read; the states re-render the
  // rows so the dragged one can dim and the target can highlight.
  const draggedRef = useRef<DraggedEntry | null>(null);
  const [dragging, setDragging] = useState<DraggedEntry | null>(null);
  const dragPressRef = useRef<{
    side: PaneSide;
    entry: FileEntry;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState<{
    side: PaneSide;
    dir: string;
  } | null>(null);

  /**
   * Reads the drop target under a point from the panes' data attributes: a
   * folder row names its own folder, the list behind it names the pane's
   * directory, and a file row has neither so the list still answers for it.
   */
  const targetAt = (x: number, y: number): DropTarget | null => {
    const element = document.elementFromPoint(x, y)?.closest("[data-drop-side]");
    const side = element?.getAttribute("data-drop-side");
    const dir = element?.getAttribute("data-drop-dir");
    if ((side !== "local" && side !== "remote") || !dir) return null;
    return { side, dir };
  };

  const beginPress = (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => {
    if (event.button !== 0 || transferring) return;
    dragPressRef.current = {
      side,
      entry,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    // Without the capture a quick flick leaves the row before the threshold
    // is reached and the drag never starts.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDragState = useStableCallback(() => {
    // A scheduled hit test must not fire after the drag is over and light a
    // highlight nothing will clear.
    hoverGate.current?.cancel();
    dragScroll.current?.stop();
    dragPressRef.current = null;
    draggedRef.current = null;
    setDragging(null);
    setDropHover(null);
  });

  // A drag held at a list's top or bottom edge keeps that list scrolling
  // (see edgeScroll.ts); the pointer position arrives with each gated hover
  // pass, and the loop keeps itself alive only while it is near an edge.
  const remoteListRef = useRef<HTMLDivElement>(null);
  const localListRef = useRef<HTMLDivElement>(null);
  const dragScroll = useRef<ReturnType<typeof createDragAutoScroll> | null>(null);
  if (dragScroll.current === null) {
    dragScroll.current = createDragAutoScroll(
      () =>
        [remoteListRef.current, localListRef.current].filter(
          (element): element is HTMLDivElement => element !== null,
        ),
      36,
      14,
      (x, y) => hoverGate.current?.schedule({ x, y }),
    );
  }

  // The drop-target hit test runs once per frame on the pointer's latest
  // position, not per pointermove: `elementFromPoint` forces a layout when
  // the DOM is dirty, and a fast pointer crosses dozens of positions a
  // frame. The release does its own hit test, so a collapsed one loses
  // nothing. See frameGate.ts.
  const hoverApply = useStableCallback((at: { x: number; y: number }) => {
    const target = targetAt(at.x, at.y);
    const source = draggedRef.current;
    const hover = source && target && dropAction(source, target) ? target : null;
    dragScroll.current?.update(at.x, at.y);
    setDropHover((current) =>
      current?.side === hover?.side && current?.dir === hover?.dir ? current : hover,
    );
  });
  const hoverGate = useRef<ReturnType<typeof createFrameGate<{ x: number; y: number }>> | null>(
    null,
  );
  if (hoverGate.current === null) {
    hoverGate.current = createFrameGate(hoverApply);
  }

  const dragMove = (event: ReactPointerEvent) => {
    const press = dragPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!draggedRef.current) {
      if (
        Math.abs(event.clientX - press.x) < DRAG_THRESHOLD &&
        Math.abs(event.clientY - press.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      const source = { side: press.side, entry: press.entry };
      draggedRef.current = source;
      setDragging(source);
    }
    hoverGate.current!.schedule({ x: event.clientX, y: event.clientY });
  };

  /** The release: whatever sits under the pointer takes the drop. */
  const dragRelease = (event: ReactPointerEvent) => {
    const source = draggedRef.current;
    const target = source ? targetAt(event.clientX, event.clientY) : null;
    const action = source && target && !transferring ? dropAction(source, target) : null;
    endDragState();
    if (!source || !target || !action) return;
    if (action.kind === "upload") {
      void runUpload(source.entry, target.dir);
    } else {
      void runDownload(source.entry, target.dir);
    }
  };

  // Escape is the only way out of a drag that stays inside the window.
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDragState();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [dragging]);

  // File tabs stay mounted while hidden, so unmount cleanup alone is not
  // enough to stop an in-progress drag and its animation frames.
  useEffect(() => {
    if (!active) endDragState();
  }, [active]);

  // A drag torn down by unmount (the tab switched mid-drag) must not let a
  // gated hit test or the edge auto-scroll fire afterwards.
  useEffect(
    () => () => {
      hoverGate.current?.cancel();
      dragScroll.current?.stop();
    },
    [],
  );

  // The row-boundary callbacks are stable identities (see useStableCallback)
  // so the memoised rows skip re-rendering when this pane re-renders — a
  // transfer tick, a hover change, a selection in the other pane. The rows
  // pass their own `side`, so the handlers need no per-pane closures.
  const itemPointerDown = useStableCallback(
    (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => beginPress(side, entry, event),
  );
  const itemPointerMove = useStableCallback((event: ReactPointerEvent) => dragMove(event));
  const itemPointerUp = useStableCallback((event: ReactPointerEvent) => dragRelease(event));
  const dragCancel = useStableCallback(() => endDragState());

  return {
    dragging,
    remoteListRef,
    itemPointerDown,
    itemPointerMove,
    itemPointerUp,
    dragCancel,
    dropHover,
    localListRef,
  };
}
