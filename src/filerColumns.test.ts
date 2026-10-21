import { beforeEach, describe, expect, it } from "vitest";

import {
  COLUMN_MAX_PX,
  DEFAULT_FILER_COLUMNS,
  clampColumnWidth,
  loadFilerColumns,
  measureCssLength,
  parseFilerColumns,
  saveFilerColumns,
  tradeBoundary,
} from "./filerColumns";
import { FILER_COLUMNS_KEY } from "./persistKeys";

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
});

describe("tradeBoundary", () => {
  // sizeStart 120 + dateStart 160 = 280 at drag begin; floors 70 and 90.
  const drag = { sizeStart: 120, dateStart: 160, sizeFloor: 70, dateFloor: 90 };

  it("trades the pointer's movement while both columns are above their floors", () => {
    // A 40px rightward drag: modified pays 40, size takes 40.
    expect(tradeBoundary({ ...drag, dateRequested: 120 })).toEqual({ size: 160, date: 120 });
    // A 40px leftward drag: size pays 40, modified takes 40. (Not 60 — size
    // only has 50 above its floor to give, and this case is the exact trade.)
    expect(tradeBoundary({ ...drag, dateRequested: 200 })).toEqual({ size: 80, date: 200 });
  });

  it("stops at the modified column's floor going right, leaving the names alone", () => {
    // The regression: asking below the floor pays only down to the floor —
    // 90, never the raw pointer ask — so the pair keeps its starting sum and
    // the name track keeps its width.
    expect(tradeBoundary({ ...drag, dateRequested: 20 })).toEqual({ size: 190, date: 90 });
    expect(tradeBoundary({ ...drag, dateRequested: -500 })).toEqual({ size: 190, date: 90 });
  });

  it("stops at the size column's floor going left, leaving the names alone", () => {
    // The symmetric half: once size sits on its floor the modified column
    // gains nothing more, however far the pointer keeps travelling.
    expect(tradeBoundary({ ...drag, dateRequested: 260 })).toEqual({ size: 70, date: 210 });
    expect(tradeBoundary({ ...drag, dateRequested: 900 })).toEqual({ size: 70, date: 210 });
  });

  it("keeps every strict trade at the sum the drag began with", () => {
    for (const dateRequested of [-500, 20, 90, 120, 160, 220, 260, 900]) {
      const { size, date } = tradeBoundary({ ...drag, dateRequested });
      expect(size + date).toBe(280);
    }
  });

  it("degrades to the raw trade where a floor could not be measured", () => {
    // jsdom lays nothing out: the pair falls back to following the pointer,
    // and the grid's own minmax floors still refuse to clip.
    expect(tradeBoundary({ ...drag, sizeFloor: null, dateFloor: null, dateRequested: 0 }))
      .toEqual({ size: clampColumnWidth(280), date: 0 });
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
    expect(parseFilerColumns({ size: 120, date: 150 })).toEqual({ size: 120, date: 150 });
  });

  it("keeps a width that was never dragged as null", () => {
    expect(parseFilerColumns({ size: 120 })).toEqual({ size: 120, date: null });
    expect(parseFilerColumns({ date: 150 })).toEqual({ size: null, date: 150 });
  });

  it("rejects a value that is not a finite number", () => {
    expect(parseFilerColumns({ size: "wide", date: 150 })).toEqual({ size: null, date: 150 });
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
      size: 0,
      date: COLUMN_MAX_PX,
    });
  });
});

describe("loadFilerColumns", () => {
  it("uses the stylesheet's own tracks when nothing is stored", () => {
    expect(loadFilerColumns()).toEqual(DEFAULT_FILER_COLUMNS);
  });

  it("round-trips a saved pair of widths", () => {
    saveFilerColumns({ size: 132, date: 168 });
    expect(loadFilerColumns()).toEqual({ size: 132, date: 168 });
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
