import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { FileEntry } from "../types";
import type { SelectMode } from "../fileBatch";
import { typeToSelect, type TypeRun } from "../fileTypeSelect";
import { useStableCallback } from "../useStableCallback";

export interface FileListKeyboardOptions {
  /** The listing in display order; the cursor indexes into it. */
  entries: readonly FileEntry[];
  /** Row pitch in px, for the scroll maths when a row is outside the window. */
  rowHeight: number;
  /**
   * The scrolling listbox itself: the single Tab stop, the element a row
   * press focuses, and the scroller a distant row is brought into.
   */
  listRef?: RefObject<HTMLDivElement | null>;
  /** Id of a row's option element, so aria and element lookups agree. */
  optionId: (path: string) => string;
  /**
   * Selection follows the cursor, the way the Filer panel's arrows do. The
   * mode says how: an arrow key replaces, Shift+arrow extends a range, and a
   * row press passes the mode its modifiers mean (see `clickMode`).
   */
  onSelect: (path: string, mode: SelectMode) => void;
  /** The double-click path: enter a folder, or open a file. */
  onActivate: (entry: FileEntry) => void;
  /**
   * Opt-in type-to-select (upstream issue #108): when true, typing the start
   * of a name moves the cursor and the selection to the entry whose name
   * starts with it. Off by default, so a list that does not want it keeps
   * exactly the named keys this hook has always handled.
   */
  typeSelect?: boolean;
}

export interface FileListKeyboard {
  /** The row `aria-activedescendant` names, or null when it is not mounted. */
  activeDescendant: string | null;
  /** Key handling for the listbox container. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** A row press: marks the cursor, focuses the list, then selects. */
  onRowSelect: (path: string, mode?: SelectMode) => void;
}

/**
 * How the keyboard cursor scrolls a row into view. Smooth is the default
 * because walking a long list with the arrow keys reads as travel; the
 * platform's reduced-motion setting turns it off. The same rule (and the
 * same words) as the Filer panel's list, so the two browsers behave alike.
 */
const revealBehavior = (): ScrollBehavior =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

/**
 * The keyboard half of a file list: one Tab stop on the listbox, a cursor
 * announced through `aria-activedescendant`, and the keys that move it. It
 * mirrors the Filer panel's model rather than inventing one — the cursor
 * lives in a ref, selection follows it, and a row outside the virtual
 * window is reached by scrolling first and pointing aria only once the row
 * exists.
 *
 * What it deliberately does not carry: the actions a menu key would open.
 * The Filer panel dispatches a `contextmenu` on the cursor row and its own
 * row handler answers; a pane with no row menu gets the same dispatch, so
 * the key works the moment one exists.
 */
export function useFileListKeyboard({
  entries,
  rowHeight,
  listRef,
  optionId,
  onSelect,
  onActivate,
  typeSelect = false,
}: FileListKeyboardOptions): FileListKeyboard {
  const activePathRef = useRef<string | null>(null);
  const [activeDescendant, setActiveDescendant] = useState<string | null>(null);
  /** Letters typed into the list since the last pause; see `typeToSelect`. */
  const typeRun = useRef<TypeRun | null>(null);

  // A new listing drops the cursor together with the old rows, and the
  // type-to-select run with it: letters typed into one directory must not
  // extend into names they never matched.
  useEffect(() => {
    typeRun.current = null;
    const path = activePathRef.current;
    if (path !== null && !entries.some((entry) => entry.path === path)) {
      activePathRef.current = null;
      setActiveDescendant(null);
    }
  }, [entries]);

  // Scrolling the window can unmount the cursor row; the listbox must not
  // keep pointing at an id that is no longer in the document.
  useEffect(() => {
    const list = listRef?.current;
    if (!list) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const path = activePathRef.current;
      if (path !== null && !document.getElementById(optionId(path))) {
        setActiveDescendant(null);
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      list.removeEventListener("scroll", onScroll);
    };
  }, [listRef, optionId]);

  /**
   * Scrolls the row at `index` into view and points aria at it, but only
   * once it is mounted. A row outside the virtual window is reached by
   * moving the scroller first and waiting for the window to render it;
   * until then the listbox itself holds the focus, never a dangling id.
   */
  const revealActiveRow = (index: number, path: string) => {
    const id = optionId(path);
    const mounted = document.getElementById(id);
    if (mounted) {
      mounted.scrollIntoView({ block: "nearest", behavior: revealBehavior() });
      setActiveDescendant(id);
      return;
    }
    const rows = listRef?.current?.querySelector<HTMLElement>(".virtual-file-rows");
    const scroller = rows?.parentElement;
    setActiveDescendant(null);
    if (!rows || !scroller) return;
    // Same origin VirtualFileRows measures from: anything above the rows
    // (the loading or error message) shifts them down in the scroller.
    const offset =
      rows.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scroller.clientTop;
    const top = offset + index * rowHeight;
    // Instant, unlike the branch above: the row is not in the document yet,
    // so there is nothing to glide towards — only a scroll that puts it there.
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + rowHeight - scroller.clientHeight;
    }
    let attempts = 0;
    const settle = () => {
      const rendered = document.getElementById(id);
      if (rendered) {
        rendered.scrollIntoView({ block: "nearest", behavior: revealBehavior() });
        setActiveDescendant(id);
        return;
      }
      if (attempts++ < 4) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  /** Moves the cursor to a row and lets the selection follow it. */
  const moveTo = (index: number, mode: SelectMode = "replace") => {
    if (entries.length === 0) return;
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    const entry = entries[clamped];
    if (!entry) return;
    activePathRef.current = entry.path;
    onSelect(entry.path, mode);
    revealActiveRow(clamped, entry.path);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The menu key — and Shift+F10, which every platform reports as F10 with
    // Shift held — opens what a right-click would, so a keyboard user reaches
    // the same row entries. The dispatch lands on the cursor row, anchored
    // at its centre, exactly where the Filer panel's list puts it; the
    // pane's own context menu (when it has one) is what answers it. The
    // browser default is left alone on purpose: until such a menu exists,
    // the native menu answers the key, the same one a right-click opens.
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.stopPropagation();
      const path = activePathRef.current;
      const target = path === null ? undefined : document.getElementById(optionId(path));
      const anchor = target ?? listRef?.current ?? null;
      const rect = anchor?.getBoundingClientRect();
      anchor?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect ? rect.left + rect.width / 2 : 0,
          clientY: rect ? rect.top + rect.height / 2 : 0,
        }),
      );
      return;
    }
    if (entries.length === 0) return;
    // Type-to-select (upstream issue #108), when the list opted in: a
    // printable key moves the cursor to the matching entry, and a key within
    // a second extends the run. Only the listbox itself takes these keys — one
    // that bubbled from an inline editor is that field's text — and modified
    // keys, named keys and IME composition fall through to the handling below.
    if (typeSelect && event.target === event.currentTarget) {
      const typed = typeToSelect(
        entries,
        activePathRef.current,
        typeRun.current,
        event.nativeEvent,
        performance.now(),
      );
      if (typed) {
        // Consumed even when nothing matched: the key was typing, and it must
        // not also trigger the platform's own find-as-you-type.
        event.preventDefault();
        typeRun.current = typed.run;
        // No match leaves the cursor and the selection where they were.
        if (entries[typed.index]) moveTo(typed.index);
        return;
      }
    }
    const path = activePathRef.current;
    const active =
      path === null ? -1 : entries.findIndex((entry) => entry.path === path);
    // Shift+arrow extends the range from the selection anchor, the way the
    // Filer panel's keyboard does; a plain arrow replaces it.
    const move = event.shiftKey ? "range" : "replace";
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(active < 0 ? 0 : active + 1, move);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveTo(active < 0 ? entries.length - 1 : active - 1, move);
        return;
      case "Home":
        event.preventDefault();
        moveTo(0, move);
        return;
      case "End":
        event.preventDefault();
        moveTo(entries.length - 1, move);
        return;
      case "Enter": {
        event.preventDefault();
        // The row the cursor is on, through the very path a double-click
        // takes: a folder is entered, a file is handed to its opener.
        const entry =
          path === null ? undefined : entries.find((item) => item.path === path);
        if (entry) onActivate(entry);
        return;
      }
    }
  };

  /**
   * A press on a row: the list takes the focus (it is the single Tab stop,
   * and a row is never in the Tab order), the cursor moves to the row, and
   * the selection follows — the Filer panel's row press does the same.
   */
  const onRowSelect = useStableCallback((path: string, mode: SelectMode = "replace") => {
    activePathRef.current = path;
    setActiveDescendant(optionId(path));
    listRef?.current?.focus({ preventScroll: true });
    onSelect(path, mode);
  });

  return {
    activeDescendant,
    onKeyDown,
    onRowSelect,
  };
}
