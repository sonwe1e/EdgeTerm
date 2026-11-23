import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LINE_HEIGHT,
  LINE_HEIGHT_KEY,
  LINE_HEIGHTS,
  lineHeightPercent,
  loadLineHeight,
  normalizeLineHeight,
  saveLineHeight,
} from "./lineHeight";

beforeEach(() => {
  localStorage.clear();
});

describe("line spacing", () => {
  it("offers an ordered range that includes the default", () => {
    expect(LINE_HEIGHTS[0]).toBe(1);
    expect([...LINE_HEIGHTS]).toEqual([...LINE_HEIGHTS].sort((a, b) => a - b));
    expect(LINE_HEIGHTS).toContain(DEFAULT_LINE_HEIGHT);
  });

  it("clamps and rounds what xterm is willing to render", () => {
    expect(normalizeLineHeight(0.5)).toBe(1);
    expect(normalizeLineHeight(9)).toBe(1.6);
    expect(normalizeLineHeight(1.234)).toBe(1.23);
    expect(normalizeLineHeight(Number.NaN)).toBe(DEFAULT_LINE_HEIGHT);
  });

  it("round-trips through storage", () => {
    saveLineHeight(1.4);
    expect(localStorage.getItem(LINE_HEIGHT_KEY)).toBe("1.4");
    expect(loadLineHeight()).toBe(1.4);
  });

  it("falls back to the default when storage holds nonsense", () => {
    localStorage.setItem(LINE_HEIGHT_KEY, "wide");
    expect(loadLineHeight()).toBe(DEFAULT_LINE_HEIGHT);
    localStorage.removeItem(LINE_HEIGHT_KEY);
    expect(loadLineHeight()).toBe(DEFAULT_LINE_HEIGHT);
  });

  it("labels a spacing as a percentage", () => {
    expect(lineHeightPercent(1)).toBe("100%");
    expect(lineHeightPercent(1.25)).toBe("125%");
  });
});
