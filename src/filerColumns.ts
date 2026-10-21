import { FILER_COLUMNS_KEY } from "./persistKeys";

/**
 * The two Filer columns whose width the user may drag, in CSS pixels.
 *
 * The name column is deliberately absent: it is the flexible track of the
 * listing's grid (`minmax(0, 1fr)`), so it takes whatever room the size and
 * modified columns leave. Narrowing either of those widens the names, which is
 * how every file manager's name column is resized — there is no separate
 * handle for it because there is no separate width to hold.
 *
 * A `null` width means "not dragged yet": the stylesheet then uses its own
 * `ch`-based track, which follows the panel font and the user's monospace
 * face. Once a column has been dragged its width is a pixel value, and the
 * stylesheet's `minmax()` floor still keeps the widest value from clipping.
 */
export interface FilerColumns {
  size: number | null;
  date: number | null;
}

export const DEFAULT_FILER_COLUMNS: FilerColumns = { size: null, date: null };

/**
 * Widest one column may be dragged. Without a ceiling a single drag could
 * take a width the panel cannot honour, and the grid would overflow the
 * sidebar instead of shrinking the names.
 */
export const COLUMN_MAX_PX = 480;

/** One dragged width, rounded and bounded; a non-finite input collapses to 0. */
export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.min(COLUMN_MAX_PX, Math.max(0, Math.round(width)));
}

/**
 * Measures one stylesheet length in px the way `host` would lay it out.
 *
 * The tracks' floors are stated in `ch`/em so they follow the panel fonts,
 * and a px copy in script would drift the first time a font changes — so the
 * px answers the drag trade needs are measured, not duplicated. The probe is
 * appended to `host` (inheriting its custom properties and fonts), kept out
 * of grid flow, and removed before anything can paint.
 *
 * Returns null when nothing was laid out (jsdom, styles not loaded): callers
 * degrade to the unmeasured behaviour rather than pinning at 0.
 */
export function measureCssLength(host: HTMLElement, value: string): number | null {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = value;
  host.appendChild(probe);
  try {
    const width = probe.getBoundingClientRect().width;
    return width > 0 ? width : null;
  } finally {
    probe.remove();
  }
}

/**
 * One step of the drag on the boundary between the size and modified columns.
 *
 * The boundary's contract is a strict trade between exactly those two counted
 * columns: each side pays only down to the floor its own track refuses to
 * cross, and gains only what the other side actually paid. The pair therefore
 * keeps the sum it began with wherever the drag still moves anything, and the
 * flexible name track — the boundary nobody is holding — is never squeezed by
 * this handle. Whichever column runs out first ends the trade: the dragged
 * boundary stops there, the way a window edge stops at the screen's edge.
 *
 * A floor that could not be measured never pins, degrading the pair to the
 * raw pointer trade (the grid's own `minmax()` still refuses to clip).
 */
export function tradeBoundary(options: {
  /** The size track's width when the drag began, in px as rendered. */
  sizeStart: number;
  /** The modified track's width when the drag began, in px as rendered. */
  dateStart: number;
  /** The modified width the pointer asks for: `dateStart - delta`, unclamped. */
  dateRequested: number;
  /** Each track's rendered floor in px, or null when it could not be measured. */
  sizeFloor: number | null;
  dateFloor: number | null;
}): { size: number; date: number } {
  const { sizeStart, dateStart, dateRequested } = options;
  const sizeFloor = options.sizeFloor ?? Number.NEGATIVE_INFINITY;
  const dateFloor = options.dateFloor ?? Number.NEGATIVE_INFINITY;
  // What each side would pay if the other always accepted: the pointer's ask,
  // refused past the payer's own floor.
  const datePays = Math.max(dateRequested, dateFloor);
  const sizePays = Math.max(sizeStart + (dateStart - datePays), sizeFloor);
  // What each side actually receives: only what the other truly gave up.
  return {
    size: clampColumnWidth(sizePays),
    date: clampColumnWidth(Math.min(datePays, dateStart - (sizePays - sizeStart))),
  };
}

/** A `FilerColumns` from an untrusted source (a settings file); null when invalid. */
export function parseFilerColumns(value: unknown): FilerColumns | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { size?: unknown; date?: unknown };
  const size =
    typeof candidate.size === "number" && Number.isFinite(candidate.size)
      ? clampColumnWidth(candidate.size)
      : null;
  const date =
    typeof candidate.date === "number" && Number.isFinite(candidate.date)
      ? clampColumnWidth(candidate.date)
      : null;
  if (size === null && date === null) return null;
  return { size, date };
}

export function loadFilerColumns(): FilerColumns {
  try {
    const parsed = parseFilerColumns(
      JSON.parse(localStorage.getItem(FILER_COLUMNS_KEY) ?? "null"),
    );
    if (parsed) return parsed;
  } catch {
    // A corrupt or blocked entry falls through to the defaults.
  }
  return DEFAULT_FILER_COLUMNS;
}

export function saveFilerColumns(columns: FilerColumns): void {
  try {
    localStorage.setItem(FILER_COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // Storage full or blocked; the in-session widths still apply.
  }
}
