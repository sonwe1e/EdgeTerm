import { beforeEach, describe, expect, it } from "vitest";

import { loadRecentTargets, RECENT_TARGETS_LIMIT } from "./quickConnectRecents";
import { useStore } from "./store";

/**
 * One writer for the remembered targets: the palette and an `ssh://` link both
 * call the store action, so the list the palette offers back cannot drift
 * between the two entry points.
 */
describe("rememberQuickTarget", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ quickConnectRecents: [] });
  });

  it("puts the newest target first and persists it", () => {
    const remember = useStore.getState().rememberQuickTarget;
    remember("root@a:22");
    remember("b.example.com");
    expect(useStore.getState().quickConnectRecents).toEqual(["b.example.com", "root@a:22"]);
    expect(loadRecentTargets()).toEqual(["b.example.com", "root@a:22"]);
  });

  it("moves a repeat to the front instead of duplicating it", () => {
    const remember = useStore.getState().rememberQuickTarget;
    remember("a");
    remember("b");
    remember("a");
    expect(useStore.getState().quickConnectRecents).toEqual(["a", "b"]);
  });

  it("keeps the list to its limit and ignores an empty label", () => {
    const remember = useStore.getState().rememberQuickTarget;
    for (let index = 0; index < RECENT_TARGETS_LIMIT + 2; index++) remember("h" + index);
    expect(useStore.getState().quickConnectRecents).toHaveLength(RECENT_TARGETS_LIMIT);
    const before = useStore.getState().quickConnectRecents;
    remember("");
    expect(useStore.getState().quickConnectRecents).toEqual(before);
  });
});
