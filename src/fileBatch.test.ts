import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  batchCollisions,
  batchItemName,
  clickMode,
  selectEntry,
  selectForMenu,
  selectedEntries,
} from "./fileBatch";
import type { FileEntry } from "./types";

const entry = (name: string, isDir = false, isSymlink = false): FileEntry => ({
  name,
  path: `/srv/${name}`,
  isDir,
  isSymlink,
  size: 1,
  modified: null,
  permissions: null,
  owner: null,
  group: null,
});

const press = (
  modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {},
  button = 0,
) => ({
  button,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...modifiers,
});

const order = ["/a", "/b", "/c", "/d", "/e"];

describe("clickMode", () => {
  it("toggles with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(clickMode(press({ metaKey: true }), true)).toBe("toggle");
    expect(clickMode(press({ ctrlKey: true }), false)).toBe("toggle");
    expect(clickMode(press({ metaKey: true }), false)).toBe("replace");
  });

  it("extends with Shift and replaces on a plain click", () => {
    expect(clickMode(press({ shiftKey: true }), true)).toBe("range");
    expect(clickMode(press({ shiftKey: true }), false)).toBe("range");
    expect(clickMode(press(), true)).toBe("replace");
  });

  it("leaves right clicks and macOS Control-click to the context menu", () => {
    expect(clickMode(press({}, 2), false)).toBeNull();
    expect(clickMode(press({}, 1), true)).toBeNull();
    expect(clickMode(press({ ctrlKey: true }), true)).toBeNull();
  });
});

describe("selectEntry", () => {
  it("replaces the selection with a plain click", () => {
    const selection = { paths: ["/a", "/c"], anchor: "/c" };
    expect(selectEntry(selection, order, "/d", "replace")).toEqual({
      paths: ["/d"],
      anchor: "/d",
    });
  });

  it("adds and drops single entries with a toggle", () => {
    let selection = selectEntry(EMPTY_SELECTION, order, "/b", "replace");
    selection = selectEntry(selection, order, "/d", "toggle");
    expect(selection).toEqual({ paths: ["/b", "/d"], anchor: "/d" });
    selection = selectEntry(selection, order, "/b", "toggle");
    expect(selection).toEqual({ paths: ["/d"], anchor: "/b" });
  });

  it("selects the span from the anchor in either direction", () => {
    const down = selectEntry({ paths: ["/b"], anchor: "/b" }, order, "/d", "range");
    expect(down).toEqual({ paths: ["/b", "/c", "/d"], anchor: "/b" });
    // The anchor stays, so a second Shift-click re-spans from it.
    expect(selectEntry(down, order, "/a", "range")).toEqual({
      paths: ["/a", "/b"],
      anchor: "/b",
    });
  });

  it("starts over when there is no anchor or it is no longer listed", () => {
    expect(selectEntry(EMPTY_SELECTION, order, "/c", "range")).toEqual({
      paths: ["/c"],
      anchor: "/c",
    });
    expect(selectEntry({ paths: ["/z"], anchor: "/z" }, order, "/c", "range")).toEqual({
      paths: ["/c"],
      anchor: "/c",
    });
  });
});

describe("selectForMenu", () => {
  it("keeps a selection the clicked entry belongs to", () => {
    const selection = { paths: ["/a", "/c"], anchor: "/c" };
    expect(selectForMenu(selection, "/a")).toBe(selection);
    expect(selectForMenu(selection, "/b")).toEqual({ paths: ["/b"], anchor: "/b" });
  });
});

describe("selectedEntries", () => {
  it("returns entries in list order, not in click order", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const picked = selectedEntries(entries, {
      paths: ["/srv/c", "/srv/a", "/srv/gone"],
      anchor: "/srv/a",
    });
    expect(picked.map((item) => item.name)).toEqual(["a", "c"]);
  });
});

describe("batchCollisions", () => {
  it("lists names already taken by the same kind", () => {
    const result = batchCollisions(
      [entry("app.log"), entry("conf", true), entry("new.txt")],
      [entry("app.log"), entry("conf", true), entry("other")],
      "local",
    );
    expect(result.blocked).toBeNull();
    expect(result.existing.map((item) => item.name)).toEqual(["app.log", "conf"]);
  });

  it("stops the whole batch on a clash with the other kind", () => {
    const result = batchCollisions(
      [entry("ok.txt"), entry("data")],
      [entry("ok.txt"), entry("data", true)],
      "local",
    );
    expect(result.blocked).toEqual({
      kind: "kindMismatch",
      existing: expect.objectContaining({ name: "data", isDir: true }),
    });
    expect(result.existing).toEqual([]);
  });

  it("refuses local links but leaves remote links to the server", () => {
    expect(batchCollisions([entry("x")], [entry("x", false, true)], "local").blocked).toEqual({
      kind: "symlink",
      existing: expect.objectContaining({ name: "x", isSymlink: true }),
    });
    expect(batchCollisions([entry("x")], [entry("x", false, true)], "remote").blocked).toBeNull();
  });

  it("matches names case-insensitively when asked", () => {
    const items = [entry("README.md")];
    const present = [entry("readme.md")];
    expect(batchCollisions(items, present, "local").existing).toEqual([]);
    expect(
      batchCollisions(items, present, "local", true).existing.map((item) => item.name),
    ).toEqual(["README.md"]);
  });

  it("keeps the listing's order for the confirmation and misses nothing", () => {
    const items = [entry("b"), entry("a"), entry("c")];
    expect(batchCollisions(items, [entry("a"), entry("b")], "remote").existing).toEqual([
      items[0],
      items[1],
    ]);
    expect(batchCollisions(items, [], "remote")).toEqual({
      blocked: null,
      existing: [],
    });
  });
});

describe("batchItemName", () => {
  it("numbers items only when there are several", () => {
    expect(batchItemName("a.txt", 0, 1)).toBe("a.txt");
    expect(batchItemName("b.txt", 1, 3)).toBe("b.txt (2/3)");
  });
});
