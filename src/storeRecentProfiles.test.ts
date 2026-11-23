import { beforeEach, describe, expect, it } from "vitest";

import { loadRecentProfiles, RECENT_PROFILES_LIMIT } from "./recentProfiles";
import { useStore } from "./store";

/**
 * Connecting to a saved profile is what puts it in the recent list; the palette
 * reads that list to mark the sessions the reader is actually working with.
 */
describe("rememberRecentProfile", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ recentProfiles: [] });
  });

  it("puts the profile first and persists it", () => {
    const remember = useStore.getState().rememberRecentProfile;
    remember("p-build");
    remember("p-local");
    expect(useStore.getState().recentProfiles).toEqual(["p-local", "p-build"]);
    expect(loadRecentProfiles()).toEqual(["p-local", "p-build"]);
  });

  it("ignores an unsaved profile (no id) and keeps the list bounded", () => {
    const remember = useStore.getState().rememberRecentProfile;
    remember("");
    expect(useStore.getState().recentProfiles).toEqual([]);
    for (let index = 0; index < RECENT_PROFILES_LIMIT + 2; index++) remember("p" + index);
    expect(useStore.getState().recentProfiles).toHaveLength(RECENT_PROFILES_LIMIT);
  });
});
