import { describe, expect, it } from "vitest";

import {
  loadRecentTargets,
  rememberTarget,
  RECENT_TARGETS_LIMIT,
  saveRecentTargets,
} from "./quickConnectRecents";
import { QUICK_CONNECT_RECENTS_KEY } from "./persistKeys";

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
};

describe("quick connect recents", () => {
  it("keeps the newest label first and drops repeats", () => {
    expect(rememberTarget(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberTarget(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("keeps at most the limit", () => {
    const labels = Array.from({ length: RECENT_TARGETS_LIMIT }, (_, index) => "h" + index);
    expect(rememberTarget(labels, "new")).toHaveLength(RECENT_TARGETS_LIMIT);
    expect(rememberTarget(labels, "new")[0]).toBe("new");
  });

  it("ignores junk instead of failing to load", () => {
    expect(loadRecentTargets(memory())).toEqual([]);
    expect(loadRecentTargets(memory({ [QUICK_CONNECT_RECENTS_KEY]: "not json" }))).toEqual([]);
    expect(loadRecentTargets(memory({ [QUICK_CONNECT_RECENTS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadRecentTargets(memory({ [QUICK_CONNECT_RECENTS_KEY]: '["a",5,"a","b"]' }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("round-trips through storage", () => {
    const storage = memory();
    saveRecentTargets(["root@h:22"], storage);
    expect(loadRecentTargets(storage)).toEqual(["root@h:22"]);
  });

  it("survives storage that refuses to write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveRecentTargets(["h"], storage)).not.toThrow();
  });
});
