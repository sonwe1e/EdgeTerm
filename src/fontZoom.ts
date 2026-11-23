import { BUFFER_FONT_SIZE } from "./storePreferences";

/**
 * One zoom step, clamped to the same bounds the display settings use. The
 * chords and the Ctrl+wheel path both go through here so neither can drift
 * away from the stored preference.
 */
export const zoomFontSize = (current: number, steps: number): number =>
  Math.min(BUFFER_FONT_SIZE.max, Math.max(BUFFER_FONT_SIZE.min, current + steps));
