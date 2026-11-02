import { beforeEach, describe, expect, it } from "vitest";

import { loadFilerSizeVisible, saveFilerSizeVisible } from "./filerColumns";
import { FILER_COLUMNS_KEY, FILER_SIZE_VISIBLE_KEY } from "./persistKeys";

beforeEach(() => {
  localStorage.clear();
});

describe("the Filer's size choice", () => {
  it("shows the size unless the user said otherwise", () => {
    expect(loadFilerSizeVisible()).toBe(true);
    saveFilerSizeVisible(false);
    expect(loadFilerSizeVisible()).toBe(false);
    saveFilerSizeVisible(true);
    expect(loadFilerSizeVisible()).toBe(true);
  });

  it("reads a corrupt value as the default and never throws", () => {
    localStorage.setItem(FILER_SIZE_VISIBLE_KEY, "{not json");
    expect(loadFilerSizeVisible()).toBe(true);
    localStorage.setItem(FILER_SIZE_VISIBLE_KEY, '"yes"');
    expect(loadFilerSizeVisible()).toBe(true);
  });

  it("ignores a stored column-width record instead of failing on it", () => {
    // The key stays registered for settings import/export and reset; its
    // value belongs to the table the dock no longer draws.
    localStorage.setItem(FILER_COLUMNS_KEY, JSON.stringify({ name: 210, size: 130, date: 140 }));
    expect(loadFilerSizeVisible()).toBe(true);
    expect(localStorage.getItem(FILER_COLUMNS_KEY)).not.toBeNull();
  });
});
