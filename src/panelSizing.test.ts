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
  resizeSides,
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
});

describe("resizeSides", () => {
  it("gives the dragged side priority and shrinks the other to its minimum", () => {
    const sides = resizeSides("left", 700, 700, 900);
    expect(sides.left).toBe(900 - SIDE_MIN - MIN_CENTER_WIDTH - 2);
    expect(sides.right).toBe(SIDE_MIN);
    expect(sides.left + sides.right + MIN_CENTER_WIDTH + 2).toBe(900);
  });

  it("leaves the opposite dock alone while the window has room", () => {
    expect(resizeSides("left", 300, 260, 1440)).toEqual({ left: 300, right: 260 });
  });

  it("does not reserve space for a hidden dock", () => {
    const sides = resizeSides("left", 700, 0, 900);
    expect(sides).toEqual({ left: 900 - MIN_CENTER_WIDTH - 2, right: 0 });
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
