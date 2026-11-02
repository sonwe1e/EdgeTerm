import { FILER_SIZE_VISIBLE_KEY } from "./persistKeys";

/**
 * The docked Filer's one column-like view choice: whether its rows carry a
 * size beside the moment.
 *
 * The three draggable column widths this module used to own are gone with the
 * table. The docked Filer is a list now — the name takes whatever the metadata
 * does not need, so hiding the size hands its room back to the name — and the
 * table with resizable columns is the dual-pane view in the terminal area.
 *
 * `edgeterm.filerColumns` stays registered in persistKeys so an older settings
 * export still imports cleanly and "restore defaults" still clears it; its
 * value is ignored. A stored record from before this change therefore loses
 * nothing the user needs: there is no width to restore.
 */

/** Missing, malformed and old settings keep the size visible. */
export function loadFilerSizeVisible(): boolean {
  try {
    return JSON.parse(localStorage.getItem(FILER_SIZE_VISIBLE_KEY) ?? "true") !== false;
  } catch {
    return true;
  }
}

export function saveFilerSizeVisible(visible: boolean): void {
  try {
    localStorage.setItem(FILER_SIZE_VISIBLE_KEY, JSON.stringify(visible));
  } catch {
    // Storage full or blocked; the in-session choice still applies.
  }
}
