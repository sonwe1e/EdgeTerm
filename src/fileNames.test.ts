import { describe, expect, it } from "vitest";

import { namesTaken, sameFileName } from "./fileNames";

// The one question every write to the user's disk asks: is this name already
// taken on this volume? It used to be written three times, and the move copy
// did not fold case, so a move replaced a file the volume treated as the same
// name. These tests pin the answer and the agreement between the callers.
describe("sameFileName", () => {
  it("folds case only when the volume does", () => {
    expect(sameFileName("README.md", "readme.md", true)).toBe(true);
    expect(sameFileName("README.md", "readme.md", false)).toBe(false);
    expect(sameFileName("a.txt", "a.txt", false)).toBe(true);
    expect(sameFileName("a.txt", "b.txt", true)).toBe(false);
  });
});

describe("namesTaken", () => {
  it("reports what the volume would replace, in the candidates' order", () => {
    expect(namesTaken(["b.txt", "a.txt"], ["A.txt", "b.TXT"], true)).toEqual(["b.txt", "a.txt"]);
    expect(namesTaken(["b.txt", "a.txt"], ["A.txt", "b.TXT"], false)).toEqual([]);
    expect(namesTaken(["x"], [], true)).toEqual([]);
  });
});

// downloadClashes used to be a second name for namesTaken; its only test
// asserted the two were equal, which kept passing after either was deleted. The
// rule is now tested once, under its own name, above.
