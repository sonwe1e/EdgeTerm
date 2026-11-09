import { describe, expect, it } from "vitest";

import {
  clampImagePan,
  constrainImageView,
  fitImageScale,
  fitImageView,
  imageCanPan,
  zoomImageAt,
} from "./imagePreviewViewport";

describe("image preview viewport geometry", () => {
  const image = { width: 2000, height: 1200 };
  const stage = { width: 800, height: 600 };

  it("fits large images without upscaling small ones", () => {
    expect(fitImageScale(image, stage)).toBeCloseTo(776 / 2000);
    expect(fitImageScale({ width: 200, height: 100 }, stage)).toBe(1);
    expect(fitImageView(image, stage)).toEqual({ scale: 776 / 2000, x: 0, y: 0, mode: "fit" });
  });

  it("preserves the hovered image point when zooming, until bounded by an edge", () => {
    const start = fitImageView(image, stage);
    const zoomed = zoomImageAt(start, image, stage, 1, 180, -120);
    const before = { x: 180 / start.scale, y: -120 / start.scale };
    const after = { x: (180 - zoomed.x) / zoomed.scale, y: (-120 - zoomed.y) / zoomed.scale };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("keeps the image on screen while dragging and recenters it when zoomed out", () => {
    expect(clampImagePan(image, stage, 1, 2000, -2000)).toEqual({ x: 600, y: -300 });
    expect(clampImagePan(image, stage, 0.2, 50, 50)).toEqual({ x: 0, y: 0 });
    expect(imageCanPan(image, stage, 1)).toBe(true);
    expect(imageCanPan(image, stage, 0.2)).toBe(false);
  });

  it("keeps custom size after a viewport resize but refits fit mode", () => {
    const wide = { width: 1000, height: 700 };
    const fitted = constrainImageView(fitImageView(image, stage), image, wide);
    expect(fitted.scale).toBeCloseTo(976 / 2000);
    expect(fitted.mode).toBe("fit");
    const custom = constrainImageView({ scale: 1, x: 600, y: -300, mode: "custom" }, image, wide);
    expect(custom).toEqual({ scale: 1, x: 500, y: -250, mode: "custom" });
  });

  it("limits wheel zoom to a safe range and can return exactly to 100%", () => {
    const initial = fitImageView(image, stage);
    expect(zoomImageAt(initial, image, stage, 100, 0, 0).scale).toBe(8);
    expect(zoomImageAt(initial, image, stage, 0.000001, 0, 0).scale).toBe(0.1);
    expect(zoomImageAt(initial, image, stage, 1, 0, 0).scale).toBe(1);
  });
});
