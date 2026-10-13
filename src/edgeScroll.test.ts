import { describe, expect, it } from "vitest";
import { edgeScrollStep } from "./edgeScroll";

const rect = { top: 100, bottom: 500, left: 0, right: 300 };

describe("edgeScrollStep", () => {
  it("scrolls up near the top edge and down near the bottom, faster when closer", () => {
    expect(edgeScrollStep(rect, 150, 100)).toBe(-14);
    expect(edgeScrollStep(rect, 150, 118)).toBe(-7);
    expect(edgeScrollStep(rect, 150, 134)).toBe(-1);
    expect(edgeScrollStep(rect, 150, 500)).toBe(14);
    expect(edgeScrollStep(rect, 150, 482)).toBe(7);
    expect(edgeScrollStep(rect, 150, 466)).toBe(1);
  });

  it("stays still through the middle and outside the container's width", () => {
    expect(edgeScrollStep(rect, 150, 300)).toBe(0);
    expect(edgeScrollStep(rect, 150, 250)).toBe(0);
    expect(edgeScrollStep(rect, 150, 140)).toBe(0);
    expect(edgeScrollStep(rect, 400, 100)).toBe(0);
    expect(edgeScrollStep(rect, -5, 480)).toBe(0);
  });

  it("still scrolls while the pointer is slightly beyond an edge, but no further", () => {
    expect(edgeScrollStep(rect, 150, 95)).toBe(-14);
    expect(edgeScrollStep(rect, 150, 505)).toBe(14);
    expect(edgeScrollStep(rect, 150, 50)).toBe(0);
    expect(edgeScrollStep(rect, 150, 550)).toBe(0);
  });
});
