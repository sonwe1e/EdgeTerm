import { describe, expect, it } from "vitest";

import {
  nextTypeAheadBuffer,
  nextTypeAheadRow,
  TYPE_AHEAD_PAUSE_MS,
  type TypeAheadRow,
} from "./sessionTypeAhead";

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

describe("nextTypeAheadBuffer", () => {
  const plain = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false });
  const empty = { text: "", at: 0 };

  it("extends the search while the keys keep coming", () => {
    const first = nextTypeAheadBuffer(empty, plain("l"), 1000);
    expect(first.action).toBe("search");
    expect(first.buffer.text).toBe("l");
    const second = nextTypeAheadBuffer(first.buffer, plain("a"), 1100);
    expect(second.buffer.text).toBe("la");
  });

  it("starts a new search after a pause", () => {
    const first = nextTypeAheadBuffer(empty, plain("l"), 1000);
    const later = nextTypeAheadBuffer(first.buffer, plain("x"), 1000 + TYPE_AHEAD_PAUSE_MS + 1);
    expect(later.buffer.text).toBe("x");
  });

  it("lets Backspace correct a typo, and leaves an empty buffer alone", () => {
    const typed = { text: "lz", at: 1000 };
    const fixed = nextTypeAheadBuffer(typed, plain("Backspace"), 1050);
    expect(fixed.buffer.text).toBe("l");
    expect(fixed.action).toBe("search");
    expect(nextTypeAheadBuffer(empty, plain("Backspace"), 1000).action).toBe("none");
  });

  it("takes Escape only when there is a search to forget", () => {
    const cleared = nextTypeAheadBuffer({ text: "la", at: 1000 }, plain("Escape"), 1010);
    expect(cleared.action).toBe("clear");
    expect(cleared.buffer.text).toBe("");
    expect(nextTypeAheadBuffer(empty, plain("Escape"), 1000).action).toBe("none");
  });

  it("ignores space, modified keys and anything longer than one character", () => {
    expect(nextTypeAheadBuffer(empty, plain(" "), 1000).action).toBe("none");
    expect(
      nextTypeAheadBuffer(empty, { key: "l", ctrlKey: true, metaKey: false, altKey: false }, 1000)
        .action,
    ).toBe("none");
    expect(nextTypeAheadBuffer(empty, plain("ArrowDown"), 1000).action).toBe("none");
  });
});
