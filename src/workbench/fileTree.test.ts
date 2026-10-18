import { describe, expect, it } from "vitest";
import { buildTree, directoryPaths } from "./fileTree";

describe("project file tree", () => {
  it("nests directories and sorts directories before files", () => {
    const tree = buildTree([
      "z.py",
      "src/train.py",
      "src/data/loader.py",
      "configs/base.yaml",
      "a.py",
    ]);
    expect(tree.dirs.map((dir) => dir.name)).toEqual(["configs", "src"]);
    expect(tree.files.map((file) => file.name)).toEqual(["a.py", "z.py"]);
    const src = tree.dirs.find((dir) => dir.name === "src");
    expect(src?.files.map((file) => file.path)).toEqual(["src/train.py"]);
    expect(src?.dirs[0].files[0].path).toBe("src/data/loader.py");
  });

  it("drops empty segments and duplicate paths without crashing", () => {
    const tree = buildTree(["", "/", "src/a.py", "src/a.py", "src/"]);
    expect(tree.files).toEqual([]);
    expect(tree.dirs).toHaveLength(1);
    expect(tree.dirs[0].files).toHaveLength(1);
  });

  it("lists every directory for an expand-all action", () => {
    const tree = buildTree(["src/data/loader.py", "src/train.py", "configs/base.yaml"]);
    expect(directoryPaths(tree).sort()).toEqual(["configs", "src", "src/data"]);
  });
});
