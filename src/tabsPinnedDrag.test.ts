import { describe, expect, it } from "vitest";

import { clampStripIndex, placeTab } from "./storeLayout";
import type { Tab } from "./storeTypes";

const tab = (id: string, pinned = false, paneId = "left"): Tab =>
  ({
    info: { id, name: id },
    profile: { id: "p-" + id, name: id },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    paneId,
    pinned,
  }) as unknown as Tab;

const ids = (tabs: Tab[]) => tabs.map((item) => item.info.id);

describe("clampStripIndex", () => {
  const strip = [tab("p1", true), tab("p2", true), tab("a"), tab("b")];

  it("keeps an unpinned tab out of the pinned region", () => {
    expect(clampStripIndex(strip, false, 0)).toBe(2);
    expect(clampStripIndex(strip, false, 1)).toBe(2);
    expect(clampStripIndex(strip, false, 3)).toBe(3);
  });

  it("keeps a pinned tab inside its region", () => {
    expect(clampStripIndex(strip, true, 0)).toBe(0);
    expect(clampStripIndex(strip, true, 1)).toBe(1);
    expect(clampStripIndex(strip, true, 3)).toBe(1);
  });

  it("lets a pinned arrival take the front of a strip with no pins", () => {
    const plain = [tab("a"), tab("b")];
    expect(clampStripIndex(plain, true, 5)).toBe(0);
    expect(clampStripIndex(plain, false, 0)).toBe(0);
    // The end of the strip is a real position: 2 is "after b".
    expect(clampStripIndex(plain, false, 9)).toBe(2);
  });

  it("keeps the invariant through a real move", () => {
    // Dragging "b" to the front of the strip must land after both pins:
    // index 2 is "before the next unpinned tab", not the pinned region.
    const moved = placeTab(strip, "b", "left", clampStripIndex(strip, false, 0));
    expect(ids(moved)).toEqual(["p1", "p2", "b", "a"]);
    expect(moved.slice(0, 2).every((item) => item.pinned)).toBe(true);

    // A pinned tab dragged rightwards stays in the pinned region.
    const pinnedMove = placeTab(strip, "p1", "left", clampStripIndex(strip, true, 3));
    expect(ids(pinnedMove)).toEqual(["p2", "p1", "a", "b"]);
  });

  it("lets a pinned arrival land after every pin of the destination", () => {
    const dest = [tab("p1", true), tab("p2", true), tab("u")];
    expect(clampStripIndex(dest, true, 9, true), "arriving breaks after p2").toBe(2);
    expect(clampStripIndex(dest, true, 9), "already there stops at the last pin").toBe(1);
  });
});
