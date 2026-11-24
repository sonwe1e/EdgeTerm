import { describe, expect, it } from "vitest";
import { parsePatch } from "./GitPatchReview";

/**
 * A combined diff is what `git diff --cc` prints for an unmerged path, and
 * the only source the conflict review shows. Its hunk headers carry one `@`
 * per parent and one `-` range per parent, and its body lines carry one prefix
 * column per parent.
 */
const CONFLICT = [
  "diff --cc src/app.rs",
  "index 1111111,2222222..3333333",
  "--- a/src/app.rs",
  "+++ b/src/app.rs",
  "@@@ -1,4 -1,4 +1,5 @@@",
  "  unchanged line",
  "++both sides added this",
  " -only ours had this",
  " +only theirs had this",
  "@@ -9,2 +9,3 @@ ordinary tail",
  " context",
  "+tail addition",
].join("\n");

describe("parsePatch", () => {
  it("reads a combined diff into hunks, not into one metadata block", () => {
    const { files, hunks, added, deleted } = parsePatch(CONFLICT);
    expect(files).toHaveLength(1);
    expect(files[0].title).toBe("src/app.rs");
    // The header, the conflict markers and the body all belong to the hunk;
    // before the fix every one of them landed in metadata instead, and the
    // review showed a bare <pre> with no line numbers, no colouring and no
    // hunk navigation.
    expect(files[0].metadata).not.toContain("@@@ -1,4 -1,4 +1,5 @@@");
    expect(files[0].metadata).not.toContain("++both sides added this");
    expect(files[0].metadata).toContain("index 1111111,2222222..3333333");

    // The header, the markers and the body all belong to the hunk; before this
    // they were pushed into metadata and the review showed a bare <pre> with
    // no line numbers, no colouring and no hunk navigation.
    expect(hunks).toHaveLength(2);
    expect(hunks[0].heading).toContain("@@@");
    expect(hunks[0].lines).toHaveLength(4);
    expect(hunks[0].lines.map((line) => line.kind)).toEqual(["context", "add", "delete", "add"]);
    expect(hunks[0].lines[1].text).toBe("both sides added this");
    expect(hunks[0].lines[2].text).toBe("only ours had this");
    expect(hunks[0].lines[3].text).toBe("only theirs had this");
    expect(added).toBe(3);
    expect(deleted).toBe(1);
  });

  it("numbers the combined hunk from the result side", () => {
    const { hunks } = parsePatch(CONFLICT);
    expect(hunks[0].lines[0]).toMatchObject({ before: 1, after: 1 });
    expect(hunks[0].lines[1]).toMatchObject({ after: 2 });
    expect(hunks[1].lines[0]).toMatchObject({ before: 9, after: 9 });
  });

  it("still reads an ordinary diff unchanged", () => {
    const ordinary = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
    ].join("\n");
    const { hunks, added, deleted } = parsePatch(ordinary);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((line) => line.kind)).toEqual(["context", "delete", "add", "add"]);
    expect(added).toBe(2);
    expect(deleted).toBe(1);
  });
});
