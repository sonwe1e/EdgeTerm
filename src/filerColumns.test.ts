import { beforeEach, describe, expect, it } from "vitest";

import {
  COLUMN_MAX_PX,
  DEFAULT_FILER_COLUMNS,
  NAME_MAX_PX,
  clampColumnWidth,
  loadFilerColumns,
  loadFilerSizeVisible,
  measureCssLength,
  parseFilerColumns,
  saveFilerColumns,
  saveFilerSizeVisible,
  suggestColumnWidth,
} from "./filerColumns";
import { FILER_COLUMNS_KEY, FILER_SIZE_VISIBLE_KEY } from "./persistKeys";

beforeEach(() => {
  localStorage.clear();
});

describe("clampColumnWidth", () => {
  it("rounds a dragged width to whole pixels", () => {
    expect(clampColumnWidth(96.4)).toBe(96);
    expect(clampColumnWidth(96.6)).toBe(97);
  });

  it("bounds a width to the range one column may occupy", () => {
    expect(clampColumnWidth(-40)).toBe(0);
    expect(clampColumnWidth(COLUMN_MAX_PX + 500)).toBe(COLUMN_MAX_PX);
  });

  it("collapses a non-finite width to zero rather than storing NaN", () => {
    // Zero, not the ceiling: a width that is not a real number has no
    // direction to clamp towards, and 0 lets the grid's own floor decide the
    // column instead of blowing it out to the maximum.
    expect(clampColumnWidth(Number.NaN)).toBe(0);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampColumnWidth(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("bounds the name column to its own, larger ceiling", () => {
    // Names are the long ones: the name column may be dragged wider than a
    // counted column ever needs to be.
    expect(clampColumnWidth(NAME_MAX_PX + 500, NAME_MAX_PX)).toBe(NAME_MAX_PX);
    expect(clampColumnWidth(COLUMN_MAX_PX + 500)).toBe(COLUMN_MAX_PX);
  });
});

describe("suggestColumnWidth", () => {
  it("answers null where text cannot be measured", () => {
    // jsdom lays nothing out and its computed styles carry no font shorthand,
    // so a double-click fit has nothing to measure: null, never a guess.
    const host = document.createElement("div");
    host.style.width = "300px";
    document.body.append(host);
    try {
      expect(
        suggestColumnWidth({
          host,
          caption: { text: "Size", font: "", arrow: 16 },
          values: ["10 B", "1.2 KB"],
          valueFont: "",
          min: null,
          max: COLUMN_MAX_PX,
        }),
      ).toBeNull();
    } finally {
      host.remove();
    }
  });
});

describe("measureCssLength", () => {
  it("answers null where nothing was laid out and cleans its probe up", () => {
    // jsdom has no layout engine: every width lays out as 0, which the helper
    // reports as "no answer" rather than a pin at zero. The px measurement
    // itself is a real-browser contract — the browser tests hold the floor it
    // measures against the track the grid actually renders.
    const host = document.createElement("div");
    host.style.width = "300px";
    document.body.append(host);
    try {
      expect(measureCssLength(host, "123px")).toBeNull();
      expect(host.childElementCount).toBe(0);
    } finally {
      host.remove();
    }
  });
});

describe("parseFilerColumns", () => {
  it("keeps both dragged widths", () => {
    expect(parseFilerColumns({ size: 120, date: 150 })).toEqual({
      name: null,
      size: 120,
      date: 150,
    });
  });

  it("keeps a width that was never dragged as null", () => {
    expect(parseFilerColumns({ size: 120 })).toEqual({ name: null, size: 120, date: null });
    expect(parseFilerColumns({ date: 150 })).toEqual({ name: null, size: null, date: 150 });
    expect(parseFilerColumns({ name: 260 })).toEqual({ name: 260, size: null, date: null });
  });

  it("reads a record from before the name column existed without clearing it", () => {
    // A stored pair of counted widths is the whole record an older build
    // wrote; learning that names have a width too must not discard them.
    expect(parseFilerColumns({ name: 300, size: 120, date: 150 })).toEqual({
      name: 300,
      size: 120,
      date: 150,
    });
  });

  it("rejects a value that is not a finite number", () => {
    expect(parseFilerColumns({ size: "wide", date: 150 })).toEqual({
      name: null,
      size: null,
      date: 150,
    });
    // A NaN on its own leaves nothing usable, so the whole record is rejected
    // and the caller keeps the stylesheet's own tracks.
    expect(parseFilerColumns({ size: Number.NaN })).toBeNull();
  });

  it("rejects anything that is not an object", () => {
    expect(parseFilerColumns(null)).toBeNull();
    expect(parseFilerColumns("120")).toBeNull();
    expect(parseFilerColumns([120, 150])).toBeNull();
  });

  it("rejects a record with no usable width at all", () => {
    expect(parseFilerColumns({})).toBeNull();
    expect(parseFilerColumns({ size: null, date: undefined })).toBeNull();
  });

  it("clamps a stored width that is out of range", () => {
    expect(parseFilerColumns({ size: -10, date: 9999 })).toEqual({
      name: null,
      size: 0,
      date: COLUMN_MAX_PX,
    });
  });
});

describe("loadFilerColumns", () => {
  it("uses the stylesheet's own tracks when nothing is stored", () => {
    expect(loadFilerColumns()).toEqual(DEFAULT_FILER_COLUMNS);
  });

  it("round-trips a saved set of widths", () => {
    saveFilerColumns({ name: 240, size: 132, date: 168 });
    expect(loadFilerColumns()).toEqual({ name: 240, size: 132, date: 168 });
  });

  it("falls through to the defaults on a corrupt entry", () => {
    localStorage.setItem(FILER_COLUMNS_KEY, "{not json");
    expect(loadFilerColumns()).toEqual(DEFAULT_FILER_COLUMNS);
  });

  it("falls through to the defaults on an unusable shape", () => {
    localStorage.setItem(FILER_COLUMNS_KEY, '{"size":"wide"}');
    expect(loadFilerColumns()).toEqual(DEFAULT_FILER_COLUMNS);
  });
});

describe("size column visibility", () => {
  it("defaults to visible for missing, corrupt, or non-boolean preferences", () => {
    expect(loadFilerSizeVisible()).toBe(true);
    for (const value of ["{", "null", '"false"', "0"]) {
      localStorage.setItem(FILER_SIZE_VISIBLE_KEY, value);
      expect(loadFilerSizeVisible()).toBe(true);
    }
  });

  it("round-trips the user's choice", () => {
    saveFilerSizeVisible(false);
    expect(loadFilerSizeVisible()).toBe(false);
    saveFilerSizeVisible(true);
    expect(loadFilerSizeVisible()).toBe(true);
  });
});
