import { beforeEach, describe, expect, it } from "vitest";

import { loadSaveLevel, scopeForLevel, scopeKey } from "./senderScope";
import { SENDER_SAVE_LEVEL_KEY } from "./persistKeys";

beforeEach(() => localStorage.clear());

describe("save level", () => {
  it("defaults to the current saved session rather than every session", () => {
    expect(loadSaveLevel()).toBe("profile");
  });

  it("remembers an explicit broader choice", () => {
    localStorage.setItem(SENDER_SAVE_LEVEL_KEY, "global");
    expect(loadSaveLevel()).toBe("global");
  });

  it("ignores an unknown stored level", () => {
    localStorage.setItem(SENDER_SAVE_LEVEL_KEY, "planet");
    expect(loadSaveLevel()).toBe("profile");
  });
});

describe("scopeForLevel", () => {
  const chain = [
    { type: "global" as const },
    { type: "kind" as const, kind: "ssh" as const },
    { type: "group" as const, id: "g1" },
  ];

  it("falls back to the nearest broader level when the tab has no profile", () => {
    expect(scopeKey(scopeForLevel(chain, "profile"))).toBe("group:g1");
  });

  it("uses the innermost group for the group level", () => {
    expect(scopeKey(scopeForLevel(chain, "group"))).toBe("group:g1");
  });
});
