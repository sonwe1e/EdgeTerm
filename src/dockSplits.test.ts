import { describe, expect, it } from "vitest";

import { DOCK_SPLITS_KEY } from "./persistKeys";
import {
  type DockWeights,
  MIN_SLOT_PX,
  equalWeights,
  loadDockWeights,
  panelSize,
  previewSplit,
  saveDockWeights,
  weightOf,
} from "./dockSplits";

const PANELS = ["filer", "sender"] as const;

describe("dock split weights", () => {
  it("reads a missing weight as an even share", () => {
    expect(weightOf({}, "filer")).toBe(1);
    expect(weightOf({ filer: 0 }, "filer")).toBe(1);
    expect(weightOf({ filer: Number.NaN }, "filer")).toBe(1);
    expect(weightOf({ filer: 3 }, "filer")).toBe(3);
  });

  it("divides the dock by weight", () => {
    expect(panelSize(PANELS, { filer: 3, sender: 1 }, "filer", 400)).toBe(300);
    expect(panelSize(PANELS, { filer: 3, sender: 1 }, "sender", 400)).toBe(100);
    expect(panelSize(PANELS, {}, "filer", 300)).toBe(150);
    expect(panelSize(PANELS, {}, "filer", 0)).toBe(0);
  });

  it("previews a drag from its start, not from the previous frame", () => {
    const start = { filer: 1, sender: 1 };
    const first = previewSplit({
      panels: PANELS,
      weights: start,
      from: "filer",
      to: "sender",
      delta: 60,
      extent: 300,
    });
    expect(first).not.toBeNull();
    expect(first!.offset).toBe(60);
    expect(first!.fromSize).toBe(210);
    expect(first!.toSize).toBe(90);

    const second = previewSplit({
      panels: PANELS,
      weights: start,
      from: "filer",
      to: "sender",
      delta: 80,
      extent: 300,
    });
    // 80px of movement is clamped by the 72px floor the other panel keeps:
    // 300 - 72 = 228, and it is measured from the drag's start, not from the
    // 60px position the previous frame showed.
    expect(second!.fromSize).toBe(228);
  });

  it("clamps at the minimum share and rests at the boundary", () => {
    const preview = previewSplit({
      panels: PANELS,
      weights: { filer: 1, sender: 1 },
      from: "filer",
      to: "sender",
      delta: 1000,
      extent: 300,
    });
    expect(preview!.toSize).toBeCloseTo(MIN_SLOT_PX, 5);
    expect(preview!.fromSize).toBeCloseTo(300 - MIN_SLOT_PX, 5);
    expect(preview!.offset).toBeCloseTo(300 - MIN_SLOT_PX - 150, 5);
  });

  it("refuses a dock with no extent and a splitter between one panel and itself", () => {
    expect(
      previewSplit({
        panels: PANELS,
        weights: {},
        from: "filer",
        to: "sender",
        delta: 10,
        extent: 0,
      }),
    ).toBeNull();
    expect(
      previewSplit({
        panels: PANELS,
        weights: {},
        from: "filer",
        to: "filer",
        delta: 10,
        extent: 300,
      }),
    ).toBeNull();
  });

  it("equalises and persists per dock", () => {
    localStorage.removeItem(DOCK_SPLITS_KEY);
    const even = equalWeights(PANELS);
    expect(even).toEqual({ filer: 1, sender: 1 });

    const arranged: DockWeights = { filer: 3, sender: 1 };
    saveDockWeights("right", PANELS, arranged);
    saveDockWeights("bottom", ["sender"], { sender: 2 });
    expect(loadDockWeights("right", PANELS)).toEqual(arranged);
    expect(loadDockWeights("bottom", ["sender"])).toEqual({ sender: 2 });
    // A panel that is no longer in the dock does not drag its old share in.
    expect(loadDockWeights("right", ["sender"])).toEqual({ sender: 1 });
    expect(loadDockWeights("left", PANELS)).toEqual({});
  });

  it("ignores a corrupt store", () => {
    localStorage.setItem(DOCK_SPLITS_KEY, "{not json");
    expect(loadDockWeights("right", PANELS)).toEqual({});
  });
});
