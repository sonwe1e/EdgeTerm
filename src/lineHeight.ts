/**
 * Terminal line spacing. xterm's `lineHeight` multiplies the font's own line
 * box, so 1 means the font's natural spacing and higher values spread rows
 * apart. Reading long logs comfortably is the reason the setting exists; the
 * default matches what the terminal has always rendered.
 */
export const LINE_HEIGHT_KEY = "edgeterm.lineHeight";

export const DEFAULT_LINE_HEIGHT = 1.25;

/** The choices the display dialog offers, lowest first. */
export const LINE_HEIGHTS = [1, 1.15, 1.25, 1.4, 1.55] as const;

/** Range xterm renders sensibly; anything else is clamped, not stored. */
export const LINE_HEIGHT_RANGE = { min: 1, max: 1.6 } as const;

/** Rounded to hundredths so a drag or an import cannot store 1.250000001. */
export function normalizeLineHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LINE_HEIGHT;
  const clamped = Math.min(LINE_HEIGHT_RANGE.max, Math.max(LINE_HEIGHT_RANGE.min, value));
  return Math.round(clamped * 100) / 100;
}

/** The saved spacing, or the default when storage is empty or unreadable. */
export function loadLineHeight(): number {
  try {
    const raw = localStorage.getItem(LINE_HEIGHT_KEY);
    if (raw === null) return DEFAULT_LINE_HEIGHT;
    return normalizeLineHeight(Number(raw));
  } catch {
    return DEFAULT_LINE_HEIGHT;
  }
}

export function saveLineHeight(value: number): void {
  try {
    localStorage.setItem(LINE_HEIGHT_KEY, String(normalizeLineHeight(value)));
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
}

/** The percentage a label shows for a spacing value. */
export const lineHeightPercent = (value: number): string => `${Math.round(value * 100)}%`;
