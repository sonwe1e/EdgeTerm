import { describe, expect, it } from "vitest";
import { zoomFontSize } from "./fontZoom";
import { BUFFER_FONT_SIZE } from "./storePreferences";

describe("zoomFontSize", () => {
  it("moves one pixel per step", () => {
    expect(zoomFontSize(14, 1)).toBe(15);
    expect(zoomFontSize(14, -1)).toBe(13);
  });

  it("stops at the bounds the display settings use", () => {
    expect(zoomFontSize(BUFFER_FONT_SIZE.max, 1)).toBe(BUFFER_FONT_SIZE.max);
    expect(zoomFontSize(BUFFER_FONT_SIZE.min, -1)).toBe(BUFFER_FONT_SIZE.min);
    expect(zoomFontSize(BUFFER_FONT_SIZE.min + 1, -5)).toBe(BUFFER_FONT_SIZE.min);
  });
});
