import { describe, expect, it } from "vitest";

// Read as text, so a handler that moves to another key cannot leave the table
// below claiming the old one. Vite resolves `?raw` to the file's contents.
import menuBarSource from "./components/MenuBar.tsx?raw";
import filerSource from "./components/panels/FilerPanel.tsx?raw";
import { CATALOGS } from "./i18n";
import { KEY_REFERENCE } from "./keyReference";

/** Every file the table may point at, so a new source has to be added here. */
const SOURCES: Record<string, string> = {
  "src/components/panels/FilerPanel.tsx": filerSource,
  "src/components/MenuBar.tsx": menuBarSource,
};

describe("the fixed-key reference", () => {
  it("names a handler that still uses every key it documents", () => {
    for (const group of KEY_REFERENCE) {
      for (const entry of group.entries) {
        const source = SOURCES[entry.source];
        expect(source, entry.source + " is one of the files this test reads").toBeTruthy();
        for (const needle of entry.needles) {
          expect(source.includes(needle), entry.source + " still handles " + needle).toBe(true);
        }
      }
    }
  });

  it("has a translated label for every row", () => {
    for (const group of KEY_REFERENCE) {
      const keys = [group.titleKey, ...group.entries.map((entry) => entry.labelKey)];
      for (const key of keys) {
        expect(CATALOGS.en[key].length, key).toBeGreaterThan(0);
        expect(CATALOGS["zh-CN"][key].length, key).toBeGreaterThan(0);
      }
    }
  });

  it("lists no key twice", () => {
    const seen = new Set<string>();
    for (const group of KEY_REFERENCE) {
      for (const entry of group.entries) {
        for (const key of entry.keys) {
          expect(seen.has(key), key + " is listed once").toBe(false);
          seen.add(key);
        }
      }
    }
  });
});
