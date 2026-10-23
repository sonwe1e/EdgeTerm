import { FILER_COLUMNS_KEY } from "./persistKeys";

/**
 * The three Filer columns whose width the user may drag, in CSS pixels.
 *
 * `null` means "not dragged yet": the track then follows the stylesheet's
 * own content width, which grows with the panel font. For the size and
 * modified columns that width is what the widest printed value needs
 * (`1023.9 KB`, `10-20 14:32`); for the name column it is no width at all —
 * the name track is the flexible one and takes whatever room the other two
 * leave, which is how a listing reads before anyone has resized anything.
 *
 * Once a column has been dragged its width is a pixel value, and the three
 * are independent: dragging one column moves the boundary on its right and
 * nothing else. When the three together are wider than the panel, the
 * listing and its caption row scroll sideways together rather than giving up
 * the widths the user set.
 *
 * The width a column may be dragged *under* is smaller than the content
 * width above: a user may narrow a column past what fits — the value
 * truncates, and the row's tooltip still carries all of it. Those hard
 * floors live in the stylesheet (`--filer-*-min`), stated in the fonts the
 * cells render in, so they follow the panel font the way the defaults do.
 */
export interface FilerColumns {
  name: number | null;
  size: number | null;
  date: number | null;
}

export const DEFAULT_FILER_COLUMNS: FilerColumns = { name: null, size: null, date: null };

/**
 * Widest the counted columns may be dragged. Without a ceiling a single
 * drag could take a width the panel cannot honour, and the sideways
 * scrolling below would grow without bound.
 */
export const COLUMN_MAX_PX = 480;

/** Widest the name column may be dragged to: names are the long ones. */
export const NAME_MAX_PX = 720;

/** One dragged width, rounded and bounded; a non-finite input collapses to 0. */
export function clampColumnWidth(width: number, max = COLUMN_MAX_PX): number {
  if (!Number.isFinite(width)) return 0;
  return Math.min(max, Math.max(0, Math.round(width)));
}

/**
 * Measures one stylesheet length in px the way `host` would lay it out.
 *
 * The tracks' widths and floors are stated in `ch`/em so they follow the
 * panel fonts, and a px copy in script would drift the first time a font
 * changes — so the px answers the drag needs are measured, not duplicated.
 * The probe is appended to `host` (inheriting its custom properties and
 * fonts), kept out of grid flow, and removed before anything can paint.
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
 * The width a double-click should give one column: enough for the widest of
 * its caption and its values, and no more. Measured with the fonts the
 * column actually renders in, through one canvas — no rows are relaid out,
 * so fitting stays cheap enough to run on a listing of any size.
 *
 * The caption's letter-spacing is not in `measureText`, so a little slack is
 * added for it; the answer is a convenience with a ceiling, not a ruler.
 * Returns null where text cannot be measured (jsdom, no canvas font):
 * callers skip the fit rather than guessing a width.
 */
export function suggestColumnWidth(options: {
  /** The caption row: the fonts below were read from its live elements. */
  host: HTMLElement;
  /** The caption as it prints (CSS uppercases it) and its own font. */
  caption: { text: string; font: string; arrow: number };
  /** The values the column prints, already formatted. */
  values: readonly string[];
  /** The font the values render in. */
  valueFont: string;
  /** The smallest width the drag rules allow, or null when unmeasured. */
  min: number | null;
  max: number;
}): number | null {
  const { caption, values, valueFont, min, max } = options;
  if (!caption.font || !valueFont) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = valueFont;
  let widest = 0;
  for (const value of values) {
    const width = ctx.measureText(value).width;
    if (width > widest) widest = width;
  }
  ctx.font = caption.font;
  const captionWidth =
    ctx.measureText(caption.text.toUpperCase()).width + caption.arrow + 6;
  const fit = Math.ceil(Math.max(widest, captionWidth)) + 8;
  if (!Number.isFinite(fit) || fit <= 0) return null;
  return Math.round(Math.min(max, Math.max(min ?? 0, fit)));
}

/** A `FilerColumns` from an untrusted source (a settings file); null when invalid. */
export function parseFilerColumns(value: unknown): FilerColumns | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { name?: unknown; size?: unknown; date?: unknown };
  const name =
    typeof candidate.name === "number" && Number.isFinite(candidate.name)
      ? clampColumnWidth(candidate.name, NAME_MAX_PX)
      : null;
  const size =
    typeof candidate.size === "number" && Number.isFinite(candidate.size)
      ? clampColumnWidth(candidate.size)
      : null;
  const date =
    typeof candidate.date === "number" && Number.isFinite(candidate.date)
      ? clampColumnWidth(candidate.date)
      : null;
  if (name === null && size === null && date === null) return null;
  // A stored record from before the name column existed keeps its counted
  // widths exactly: reading it never clears what the user already set.
  return { name, size, date };
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
