/**
 * Keyboard region cycling (F6 / Shift+F6).
 *
 * A terminal owns every key it is given, Tab included: xterm turns Tab into
 * HT for the shell, so once focus is inside a session there is no way back
 * out to the tabs, the panels or the status bar. F6 is the desktop
 * convention for exactly this (browsers, IDEs, Windows panes), and it is the
 * one key the terminal leaves to the window.
 *
 * Regions declare themselves with `data-focus-region`; DOM order is the
 * cycle order. A region focuses its first useful control rather than the
 * wrapper where it can (the terminal's hidden textarea, a listbox).
 */

const REGION_SELECTOR = "[data-focus-region]";

function isVisible(element: HTMLElement): boolean {
  return (
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

/** What inside a region should actually take focus. */
function focusTarget(region: HTMLElement): HTMLElement {
  const terminal = region.querySelector<HTMLElement>(".xterm-helper-textarea");
  if (terminal) return terminal;
  const listbox = region.querySelector<HTMLElement>("[role='listbox']");
  if (listbox) return listbox;
  return region;
}

/**
 * Move focus to the next (step 1) or previous (step -1) region, wrapping at
 * the ends. Returns false when the interface has no regions (the workbench,
 * for instance), so the caller can leave the key alone.
 */
export function focusNextRegion(step: 1 | -1): boolean {
  const regions = Array.from(
    document.querySelectorAll<HTMLElement>(REGION_SELECTOR),
  ).filter(isVisible);
  if (regions.length === 0) return false;
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const owner = active?.closest<HTMLElement>(REGION_SELECTOR) ?? null;
  const start = owner ? regions.indexOf(owner) : -1;
  const next = regions[(start + step + regions.length) % regions.length];
  if (!next) return false;
  focusTarget(next).focus({ preventScroll: true });
  return true;
}
