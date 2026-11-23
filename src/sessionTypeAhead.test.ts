import { describe, expect, it } from "vitest";

import { nextTypeAheadRow, type TypeAheadRow } from "./sessionTypeAhead";

const rows: TypeAheadRow[] = [
  { index: 0, label: "Build server" },
  { index: 2, label: "Lab box" },
  { index: 3, label: "Lathe" },
  { index: 5, label: "prod-db" },
];

describe("nextTypeAheadRow", () => {
  it("finds the next row whose name starts with what was typed", () => {
    expect(nextTypeAheadRow(rows, 0, "l")).toBe(2);
    expect(nextTypeAheadRow(rows, 0, "P")).toBe(5);
    expect(nextTypeAheadRow(rows, 2, "la")).toBe(3);
  });

  it("wraps around the end", () => {
    expect(nextTypeAheadRow(rows, 5, "b")).toBe(0);
    expect(nextTypeAheadRow(rows, 3, "l")).toBe(2);
  });

  it("returns nothing for an empty query or no match", () => {
    expect(nextTypeAheadRow(rows, 0, "")).toBeNull();
    expect(nextTypeAheadRow(rows, 0, "   ")).toBeNull();
    expect(nextTypeAheadRow(rows, 0, "zz")).toBeNull();
    expect(nextTypeAheadRow([], 0, "a")).toBeNull();
  });

  it("starts after the current row, so a repeated letter advances", () => {
    // "l" from the "Lab box" row moves on to "Lathe".
    expect(nextTypeAheadRow(rows, 2, "l")).toBe(3);
    // and from the last L row it wraps to the first one again.
    expect(nextTypeAheadRow(rows, 3, "l")).toBe(2);
  });
});
