import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FILE_SORT,
  loadFileSort,
  parseFileSort,
  saveFileSort,
  sortFileEntries,
  toggleFileSort,
  type FileSort,
} from "./fileSort";
import type { FileEntry } from "./types";

afterEach(() => vi.unstubAllGlobals());

const entry = (name: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/${name}`,
  isDir: false,
  isSymlink: false,
  size: 0,
  modified: null,
  permissions: null,
  owner: null,
  group: null,
  ...overrides,
});

const names = (entries: FileEntry[]): string[] => entries.map((e) => e.name);

describe("sortFileEntries", () => {
  it("sorts naturally by default, the way Explorer and Finder do", () => {
    const entries = [entry("file10"), entry("file2"), entry("a-dir", { isDir: true })];
    const sorted = sortFileEntries(entries, DEFAULT_FILE_SORT);
    expect(names(sorted)).toEqual(["a-dir", "file2", "file10"]);
    expect(sorted).not.toBe(entries);
  });

  it("still honours a legacy stored order that predates the natural default", () => {
    // No `explicit` flag: an old stored value whose owner kept backend order.
    const entries = [entry("file10"), entry("file2")];
    expect(names(sortFileEntries(entries, { key: "name", direction: "asc" }))).toEqual([
      "file10",
      "file2",
    ]);
  });

  it("sorts by name case-insensitively and in natural numeric order once asked", () => {
    const entries = [entry("readme10.txt"), entry("Beta"), entry("alpha"), entry("file2")];
    // The collator orders digit runs numerically in both directions.
    expect(names(sortFileEntries(entries, { key: "name", direction: "desc" }))).toEqual([
      "readme10.txt",
      "file2",
      "Beta",
      "alpha",
    ]);
  });

  it("sorts by modified time and keeps unknown times last in both directions", () => {
    const entries = [
      entry("unknown"),
      entry("newest", { modified: 300 }),
      entry("oldest", { modified: 100 }),
      entry("middle", { modified: 200 }),
    ];
    const asc = names(sortFileEntries(entries, { key: "modified", direction: "asc" }));
    const desc = names(sortFileEntries(entries, { key: "modified", direction: "desc" }));
    expect(asc).toEqual(["oldest", "middle", "newest", "unknown"]);
    expect(desc).toEqual(["newest", "middle", "oldest", "unknown"]);
  });

  it("sorts by size", () => {
    const entries = [
      entry("big", { size: 300 }),
      entry("small", { size: 100 }),
      entry("mid", { size: 200 }),
    ];
    expect(names(sortFileEntries(entries, { key: "size", direction: "asc" }))).toEqual([
      "small",
      "mid",
      "big",
    ]);
    expect(names(sortFileEntries(entries, { key: "size", direction: "desc" }))).toEqual([
      "big",
      "mid",
      "small",
    ]);
  });

  it("keeps directories ahead of files under every key and direction", () => {
    const entries = [
      entry("z-file", { size: 5, modified: 900 }),
      entry("a-dir", { isDir: true, size: 0, modified: 100 }),
      entry("m-dir", { isDir: true, size: 0, modified: 500 }),
    ];
    for (const key of ["name", "modified", "size"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        if (key === "name" && direction === "asc") {
          // A legacy stored value (no `explicit`) still passes the backend
          // order through; the natural default is covered by the first test.
          continue;
        }
        const sorted = sortFileEntries(entries, { key, direction });
        // The two directories lead in their own directional order; only the
        // file/dir split itself is fixed.
        expect(names(sorted.slice(0, 2)).sort()).toEqual(["a-dir", "m-dir"]);
        expect(sorted[2]?.name).toBe("z-file");
      }
    }
  });
});

describe("toggleFileSort", () => {
  it("distinguishes an explicit ascending name sort from legacy backend order", () => {
    const entries = [entry("file10"), entry("file2")];
    const descending = toggleFileSort(DEFAULT_FILE_SORT, "name");
    const ascending = toggleFileSort(descending, "name");
    const legacy = { key: "name", direction: "asc" } as const;
    expect(names(sortFileEntries(entries, legacy))).toEqual(["file10", "file2"]);
    expect(names(sortFileEntries(entries, DEFAULT_FILE_SORT))).toEqual(["file2", "file10"]);
    expect(names(sortFileEntries(entries, descending))).toEqual(["file10", "file2"]);
    expect(names(sortFileEntries(entries, ascending))).toEqual(["file2", "file10"]);
    saveFileSort(ascending);
    expect(names(sortFileEntries(entries, loadFileSort()))).toEqual(["file2", "file10"]);
  });
  it("starts a new key ascending and flips the active one", () => {
    let sort: FileSort = DEFAULT_FILE_SORT;
    sort = toggleFileSort(sort, "modified");
    expect(sort).toEqual({ key: "modified", direction: "asc" });
    sort = toggleFileSort(sort, "modified");
    expect(sort).toEqual({ key: "modified", direction: "desc" });
    sort = toggleFileSort(sort, "modified");
    expect(sort).toEqual({ key: "modified", direction: "asc" });
    sort = toggleFileSort(sort, "size");
    expect(sort).toEqual({ key: "size", direction: "asc" });
  });
});

describe("parseFileSort", () => {
  it("accepts a valid sort from an untrusted file and rejects the rest", () => {
    expect(parseFileSort({ key: "modified", direction: "desc" })).toEqual({
      key: "modified",
      direction: "desc",
    });
    expect(parseFileSort({ key: "name", direction: "asc" })).toEqual({
      key: "name",
      direction: "asc",
    });
    expect(parseFileSort({ key: "bogus", direction: "asc" })).toBeNull();
    expect(parseFileSort({ key: "name", direction: "sideways" })).toBeNull();
    expect(parseFileSort("name")).toBeNull();
    expect(parseFileSort(null)).toBeNull();
  });
});

describe("filer sort persistence", () => {
  it("round-trips through localStorage and rejects corrupt values", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });

    saveFileSort({ key: "modified", direction: "desc" });
    expect(loadFileSort()).toEqual({ key: "modified", direction: "desc" });

    store.set("edgeterm.filerSort", "{not json");
    expect(loadFileSort()).toEqual(DEFAULT_FILE_SORT);

    store.set("edgeterm.filerSort", '{"key":"bogus","direction":"asc"}');
    expect(loadFileSort()).toEqual(DEFAULT_FILE_SORT);
  });
});
