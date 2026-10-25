/**
 * Pixel geometry of the docked panels, kept out of the store because it is
 * pure layout: the splitter drags write it, App reads it, and nothing else
 * depends on it. Persisting it is the difference between a layout the user
 * arranged once and one they re-arrange at every launch.
 *
 * Every value is clamped against the live viewport, not just to a fixed
 * range: two 720px side docks on a 900px window would otherwise leave the
 * terminal at zero width with no way to tell why.
 */
import { PANEL_SIZING_KEY } from "./persistKeys";

export const SIDE_MIN = 150;
export const SIDE_MAX = 720;
export const BOTTOM_MIN = 80;
export const BOTTOM_MAX = 600;
/** The terminal must keep at least this much room when a dock is dragged. */
export const MIN_CENTER_WIDTH = 320;
export const MIN_TERMINAL_HEIGHT = 200;
/** Menubar (28px) + status bar (24px), both fixed, plus the splitter line. */
export const CHROME_HEIGHT = 28 + 24 + 1;

export interface PanelSizing {
  left: number;
  right: number;
  bottom: number;
  senderExpanded: boolean;
}

export const DEFAULT_PANEL_SIZING: PanelSizing = {
  left: 220,
  // The Filer's column grid is fixed-track: at the largest panel font (18px)
  // its icon, size and date tracks plus gaps need ~248px, and the rows add a
  // 24px inset over the scroller's ~15px bar — about 287px in total. At 220px
  // the name track collapsed to zero and the dates ran past the panel edge
  // (the app font gate fails date containment at 18px on both viewports). The
  // session tree on the left has no fixed-width columns, so it keeps 220px.
  right: 300,
  bottom: 160,
  senderExpanded: false,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The widest this side dock may be without taking the terminal below its
 * minimum. `other` is the opposite dock's width, 0 when it is hidden.
 *
 * This is the whole rule for one splitter drag: the dragged side stops where
 * the centre's reserve begins, and the opposite dock is nobody's to shrink —
 * a drag on one side never decides what the other side shows. Both the
 * pointer and the keyboard go through it, so every way of asking for a width
 * meets the same boundary.
 */
export function clampSide(desired: number, viewportWidth: number, other: number): number {
  const fit = viewportWidth - other - MIN_CENTER_WIDTH - 2;
  return Math.round(clamp(Math.min(desired, fit), SIDE_MIN, SIDE_MAX));
}

/** The tallest the bottom dock may be on this window. */
export function clampBottom(desired: number, viewportHeight: number): number {
  const fit = viewportHeight - CHROME_HEIGHT - MIN_TERMINAL_HEIGHT;
  return Math.round(clamp(Math.min(desired, fit), BOTTOM_MIN, BOTTOM_MAX));
}

/**
 * Restores both side widths together. A stored layout from a larger window
 * is scaled down rather than letting one side keep a width that no longer
 * fits; each side still gets its minimum before the centre gives way.
 */
export function fitSides(
  left: number,
  right: number,
  viewportWidth: number,
): { left: number; right: number } {
  let nextLeft = clamp(Math.round(left), SIDE_MIN, SIDE_MAX);
  let nextRight = clamp(Math.round(right), SIDE_MIN, SIDE_MAX);
  const over = nextLeft + nextRight + MIN_CENTER_WIDTH + 2 - viewportWidth;
  if (over <= 0) return { left: nextLeft, right: nextRight };
  const capacity = Math.max(SIDE_MIN * 2, viewportWidth - MIN_CENTER_WIDTH - 2);
  const total = nextLeft + nextRight;
  nextLeft = Math.max(SIDE_MIN, Math.floor((nextLeft * capacity) / total));
  nextRight = Math.max(SIDE_MIN, capacity - nextLeft);
  return { left: nextLeft, right: nextRight };
}

export function loadPanelSizing(): PanelSizing {
  const fallback = { ...DEFAULT_PANEL_SIZING };
  let stored: Partial<PanelSizing> = {};
  try {
    const raw = localStorage.getItem(PANEL_SIZING_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        stored = parsed as Partial<PanelSizing>;
      }
    }
  } catch {
    // A corrupt or blocked entry falls through to the defaults.
  }
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const sides = fitSides(
    finite(stored.left, fallback.left),
    finite(stored.right, fallback.right),
    viewportWidth,
  );
  return {
    left: sides.left,
    right: sides.right,
    bottom: clampBottom(finite(stored.bottom, fallback.bottom), viewportHeight),
    senderExpanded: stored.senderExpanded === true,
  };
}

export function savePanelSizing(sizing: PanelSizing): void {
  try {
    localStorage.setItem(PANEL_SIZING_KEY, JSON.stringify(sizing));
  } catch {
    // The layout still applies for this run when storage is unavailable.
  }
}
