import { describe, expect, it, beforeEach } from "vitest";
import {
  BOTTOM_MAX,
  BOTTOM_MIN,
  MIN_CENTER_WIDTH,
  MIN_TERMINAL_HEIGHT,
  SIDE_MAX,
  SIDE_MIN,
  clampBottom,
  clampSide,
  fitSides,
  loadPanelSizing,
  savePanelSizing,
} from "./panelSizing";
import { PANEL_SIZING_KEY } from "./persistKeys";

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1440;
  window.innerHeight = 900;
});

describe("clampSide", () => {
  it("keeps the centre at its minimum against a fixed opposite dock", () => {
    expect(clampSide(700, 1440, 400)).toBe(700);
    expect(clampSide(900, 1440, 400)).toBe(1440 - 400 - MIN_CENTER_WIDTH - 2);
  });

  it("honours the fixed range when the window is roomy", () => {
    expect(clampSide(10, 1440, 220)).toBe(SIDE_MIN);
    expect(clampSide(900, 1440, 220)).toBe(SIDE_MAX);
  });

  it("never returns a fractional width", () => {
    expect(clampSide(300.6, 1440, 220)).toBe(301);
  });

  it("answers for one side only, so a drag cannot move the opposite dock", () => {
    // The old rule resolved a drag across both docks: the dragged side took
    // what it asked for and the opposite gave way down to its minimum.
    // clampSide is the whole rule for the dragged side alone — the opposite
    // dock's width is an input it must respect, and nothing about dragging
    // one side rewrites the other. Whatever the pointer asks for past the
    // centre's reserve, the answer stops there.
    expect(clampSide(2000, 900, 400)).toBe(900 - 400 - MIN_CENTER_WIDTH - 2);
    expect(clampSide(2000, 900, 0)).toBe(900 - MIN_CENTER_WIDTH - 2);
  });

  it("leaves a width that already fits untouched", () => {
    expect(clampSide(300, 1440, 260)).toBe(300);
  });
});

describe("clampBottom", () => {
  it("leaves the terminal its minimum height in a 560px window", () => {
    expect(clampBottom(600, 560)).toBe(560 - 28 - 24 - 1 - MIN_TERMINAL_HEIGHT);
  });

  it("keeps the bottom dock within its range", () => {
    expect(clampBottom(10, 900)).toBe(BOTTOM_MIN);
    expect(clampBottom(2000, 900)).toBe(BOTTOM_MAX);
  });
});

describe("fitSides", () => {
  it("returns stored widths unchanged when they fit", () => {
    expect(fitSides(220, 260, 1440)).toEqual({ left: 220, right: 260 });
  });

  it("scales both sides down on a smaller window without starving either", () => {
    const fitted = fitSides(700, 700, 900);
    expect(fitted.left + fitted.right).toBeLessThanOrEqual(
      900 - MIN_CENTER_WIDTH - 2,
    );
    expect(fitted.left).toBeGreaterThanOrEqual(SIDE_MIN);
    expect(fitted.right).toBeGreaterThanOrEqual(SIDE_MIN);
  });
});

describe("loadPanelSizing", () => {
  it("uses the documented defaults when nothing is stored", () => {
    expect(loadPanelSizing()).toEqual({
      left: 220,
      right: 300,
      bottom: 160,
      senderExpanded: false,
    });
  });

  it("round-trips a saved layout", () => {
    savePanelSizing({ left: 360, right: 280, bottom: 240, senderExpanded: true });
    expect(loadPanelSizing()).toEqual({
      left: 360,
      right: 280,
      bottom: 240,
      senderExpanded: true,
    });
  });

  it("repairs corrupt and out-of-range values", () => {
    localStorage.setItem(PANEL_SIZING_KEY, '{"left":"wide","right":9999,"bottom":-5}');
    const loaded = loadPanelSizing();
    expect(loaded.left).toBe(220);
    expect(loaded.right).toBe(SIDE_MAX);
    expect(loaded.bottom).toBe(BOTTOM_MIN);
    expect(loaded.senderExpanded).toBe(false);
  });

  it("fits a layout saved on a wider window", () => {
    localStorage.setItem(
      PANEL_SIZING_KEY,
      JSON.stringify({ left: 700, right: 700, bottom: 300, senderExpanded: false }),
    );
    window.innerWidth = 900;
    const loaded = loadPanelSizing();
    expect(loaded.left + loaded.right + MIN_CENTER_WIDTH + 2).toBeLessThanOrEqual(
      900,
    );
  });
});
