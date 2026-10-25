import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

// Hover tracking for the submenus of a dropdown or context menu.
//
// A submenu opens when the pointer enters its parent row
// (`.menu-submenu-entry`) and stays open while the pointer is over the row or
// the submenu itself. Leaving them does not close it at once: CSS `:hover`
// alone dropped the submenu the moment the pointer left the row, and the
// pointer leaves it on every trip to a lower submenu entry, cutting through
// the row below or dwelling in the gap before the panel (issue #53: View →
// Theme → Light could not be reached with the mouse on Windows). Instead the
// submenu is kept while the pointer stays inside the triangle between the
// point where it left and the submenu's near edge, the "safe triangle" of
// native macOS menus, and closes as soon as it moves elsewhere over the menu
// or rests in the triangle for longer than SUBMENU_GRACE_MS. Leaving the menu
// altogether keeps the submenu where it is, as native menus do.
//
// One submenu per level is open at a time. An entry's key is its index in its
// level; a nested level extends its parent's key (`submenuKey`), so an open
// nested submenu keeps its ancestors open.

/** How long the pointer may rest inside the triangle before that counts as leaving. */
export const SUBMENU_GRACE_MS = 400;

/**
 * How far the triangle's base reaches past the ends of the submenu's edge,
 * for hands that do not travel in straight lines.
 */
export const SUBMENU_GRACE_MARGIN = 16;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Triangle = [Point, Point, Point];

/**
 * The triangle between the point where the pointer left and the near edge of
 * the submenu, or null when the pointer left above or below the submenu
 * rather than beside it (nothing to head for then).
 */
export function graceTriangle(
  exit: Point,
  submenu: Box,
  margin = SUBMENU_GRACE_MARGIN,
): Triangle | null {
  let edge: number;
  if (exit.x <= submenu.left) edge = submenu.left;
  else if (exit.x >= submenu.right) edge = submenu.right;
  else return null;
  return [exit, { x: edge, y: submenu.top - margin }, { x: edge, y: submenu.bottom + margin }];
}

/** Whether the point lies in the triangle, its edges included. */
export function insideTriangle(point: Point, [a, b, c]: Triangle): boolean {
  const ab = cross(a, b, point);
  const bc = cross(b, c, point);
  const ca = cross(c, a, point);
  const negative = ab < 0 || bc < 0 || ca < 0;
  const positive = ab > 0 || bc > 0 || ca > 0;
  return !(negative && positive);
}

function cross(from: Point, to: Point, point: Point): number {
  return (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
}

/** The key of the submenu entry at `index` in the level under `parent` (undefined at the top). */
export function submenuKey(parent: string | undefined, index: number): string {
  return parent === undefined ? String(index) : `${parent}.${index}`;
}

function parentKey(key: string): string | null {
  const dot = key.lastIndexOf(".");
  return dot === -1 ? null : key.slice(0, dot);
}

/** Whether `open` is `key` or a submenu nested inside it. */
function within(key: string, open: string | null): boolean {
  return open !== null && (open === key || open.startsWith(`${key}.`));
}

interface Grace {
  key: string;
  triangle: Triangle | null;
  /** Reset by every move inside the triangle. */
  until: number;
}

export interface SubmenuHover {
  /** Whether the entry's submenu is shown. */
  isOpen(key: string): boolean;
  /** Handlers for the `.menu-submenu-entry` element with this key. */
  entryProps(key: string): {
    onMouseEnter: () => void;
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  /** Handlers for the menu's root element. */
  rootProps: { onMouseMove: (event: ReactMouseEvent<HTMLElement>) => void };
}

export function useSubmenuHover(): SubmenuHover {
  const [open, setOpen] = useState<string | null>(null);
  // The submenu the pointer has just left, kept open while it may be on its
  // way over; never set while the pointer is inside an open entry.
  const grace = useRef<Grace | null>(null);

  const onMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const pending = grace.current;
    if (!pending) return;
    const now = Date.now();
    const point = { x: event.clientX, y: event.clientY };
    if (pending.triangle && now <= pending.until && insideTriangle(point, pending.triangle)) {
      pending.until = now + SUBMENU_GRACE_MS;
      return;
    }
    grace.current = null;
    setOpen((current) => (within(pending.key, current) ? parentKey(pending.key) : current));
  };

  return {
    isOpen: (key) => within(key, open),
    entryProps: (key) => ({
      onMouseEnter: () => {
        grace.current = null;
        setOpen(key);
      },
      onMouseLeave: (event) => {
        const submenu = submenuOf(event.currentTarget);
        const exit = { x: event.clientX, y: event.clientY };
        grace.current = {
          key,
          triangle: submenu ? graceTriangle(exit, submenu.getBoundingClientRect()) : null,
          until: Date.now() + SUBMENU_GRACE_MS,
        };
      },
    }),
    rootProps: { onMouseMove },
  };
}

function submenuOf(entry: HTMLElement): Element | null {
  for (const child of entry.children) {
    if (child.classList.contains("menu-submenu")) return child;
  }
  return null;
}
