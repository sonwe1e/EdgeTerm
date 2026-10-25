import { describe, expect, it } from "vitest";

import { fileIconSource } from "./fileIcons";

// Resolution contract, in the order VS Code resolves a file icon theme:
// exact file name, then the longest matching extension, then the theme
// default - case-insensitively, with the light palettes overriding where the
// theme defines them. The assertions compare returned URLs with each other
// instead of pinning asset paths, so they hold in dev (source paths) and in
// the built bundle (hashed asset URLs) alike.

describe("bundled Material file icons", () => {
  it("matches case-insensitively and shares one URL per icon", () => {
    expect(fileIconSource("First.TS", false, "dark")).toBe(
      fileIconSource("first.ts", false, "dark"),
    );
    expect(fileIconSource("a.ts", false, "dark")).toBe(fileIconSource("b.ts", false, "dark"));
  });

  it("prefers the longest matching suffix the theme actually maps", () => {
    // The theme maps "d.ts" to its own definition icon and plain "ts" to
    // the ordinary TypeScript icon, so the composite suffix must win; a
    // lookup that only tried the last suffix would land on "ts" instead.
    expect(fileIconSource("app.d.ts", false, "dark")).not.toBe(
      fileIconSource("app.ts", false, "dark"),
    );
    // Same shape one level deeper: "spec.ts" is a test-file icon, not "ts".
    expect(fileIconSource("app.spec.ts", false, "dark")).not.toBe(
      fileIconSource("app.ts", false, "dark"),
    );
    // A name whose composite suffixes are unmapped falls through to the
    // plain suffix ("gz" is the theme's archive icon).
    expect(fileIconSource("archive.tar.gz", false, "dark")).toBe(
      fileIconSource("notes.gz", false, "dark"),
    );
  });

  it("matches an exact file name before any extension", () => {
    // "package.json" is an exact fileName entry (the nodejs icon); a plain
    // JSON file goes through the "json" extension. The two differ, which is
    // only possible if the exact table is consulted first.
    expect(fileIconSource("package.json", false, "dark")).not.toBe(
      fileIconSource("notes.json", false, "dark"),
    );
  });

  it("lets the light palettes override and passes everything else through", () => {
    // The theme defines a light variant for SConstruct and none for TypeScript.
    expect(fileIconSource("sconstruct", false, "light")).not.toBe(
      fileIconSource("sconstruct", false, "dark"),
    );
    expect(fileIconSource("a.ts", false, "light")).toBe(fileIconSource("a.ts", false, "dark"));
    // Same for folders: "src" has no light folder icon of its own.
    expect(fileIconSource("src", true, "light")).toBe(fileIconSource("src", true, "dark"));
  });

  it("keeps separate defaults for unknown files and folders", () => {
    const file = fileIconSource("name-without-extension.zzz", false, "dark");
    const folder = fileIconSource("name-without-extension.zzz", true, "dark");
    expect(file).not.toBe(folder);
    // The "src" folder has its own icon, distinct from the default folder.
    expect(fileIconSource("src", true, "dark")).not.toBe(folder);
  });

  it("returns a non-empty URL for every queried name", () => {
    for (const [name, isDir] of [
      ["package.json", false],
      ["main.rs", false],
      ["build", true],
      ["notes.txt", false],
    ] as const) {
      const source = fileIconSource(name, isDir, "serialx-dark");
      expect(source.length).toBeGreaterThan(0);
    }
  });
});
