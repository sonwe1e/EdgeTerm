import { describe, expect, it } from "vitest";

import { namesTaken } from "./fileNames";

/**
 * A directory download replaces a same-named local file in place, with no
 * dialog of its own, so these names decide whether the user is asked at all.
 */
describe("download clashes", () => {
  it("matches names exactly where the volume is case sensitive", () => {
    expect(namesTaken(["README.md"], ["readme.md"], false)).toEqual([]);
    expect(namesTaken(["README.md"], ["README.md"], false)).toEqual(["README.md"]);
  });

  it("matches names that differ only in case where the volume is not", () => {
    // Windows and macOS write through to the existing file: not asking is a
    // silent replacement.
    expect(namesTaken(["README.md"], ["readme.md"], true)).toEqual(["README.md"]);
    expect(namesTaken(["a.txt", "b.txt"], ["A.TXT"], true)).toEqual(["a.txt"]);
  });

  it("reports each clashing name once and keeps the order of the selection", () => {
    expect(namesTaken(["b.txt", "a.txt"], ["A.txt", "b.TXT"], true)).toEqual(["b.txt", "a.txt"]);
    expect(namesTaken(["x"], [], true)).toEqual([]);
  });
});
