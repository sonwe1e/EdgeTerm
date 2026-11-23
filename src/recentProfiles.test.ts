import { describe, expect, it } from "vitest";

import { RECENT_PROFILES_KEY } from "./persistKeys";
import {
  loadRecentProfiles,
  RECENT_PROFILES_LIMIT,
  rememberProfile,
  saveRecentProfiles,
} from "./recentProfiles";

const memory = (data: Record<string, string> = {}) => {
  const store = { ...data };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
};

describe("recent profiles", () => {
  it("keeps the newest id first and moves a repeat rather than duplicating it", () => {
    expect(rememberProfile(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberProfile(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("keeps at most the limit", () => {
    const ids = Array.from({ length: RECENT_PROFILES_LIMIT }, (_, index) => "p" + index);
    expect(rememberProfile(ids, "new")).toHaveLength(RECENT_PROFILES_LIMIT);
    expect(rememberProfile(ids, "new")[0]).toBe("new");
  });

  it("drops junk instead of failing to load", () => {
    expect(loadRecentProfiles(memory())).toEqual([]);
    expect(loadRecentProfiles(memory({ [RECENT_PROFILES_KEY]: "not json" }))).toEqual([]);
    expect(loadRecentProfiles(memory({ [RECENT_PROFILES_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadRecentProfiles(memory({ [RECENT_PROFILES_KEY]: '["a",7,"a",""]' }))).toEqual(["a"]);
  });

  it("round-trips and survives a store that refuses writes", () => {
    const storage = memory();
    saveRecentProfiles(["p-build"], storage);
    expect(loadRecentProfiles(storage)).toEqual(["p-build"]);
    expect(() =>
      saveRecentProfiles(["p"], {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });
});
