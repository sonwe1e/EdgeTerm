import { describe, expect, it } from "vitest";
import { keepsConnectProfile } from "./sessionConnectPlan";

describe("keepsConnectProfile", () => {
  it("saves a named profile", () => {
    expect(keepsConnectProfile({ kind: "ssh", name: "db", startup: "" })).toBe(true);
  });

  it("leaves the built-in local row alone", () => {
    expect(keepsConnectProfile({ kind: "local", name: "shell", startup: "" })).toBe(false);
  });

  it("saves the one-off local shell once a startup command is typed", () => {
    // The command is filed under the profile id, so nothing saved means it is
    // silently dropped.
    expect(keepsConnectProfile({ kind: "local", name: "shell", startup: "cd /srv" })).toBe(true);
    expect(keepsConnectProfile({ kind: "local", name: "shell", startup: "   " })).toBe(false);
  });

  it("saves a profile that already has an id and a name", () => {
    // The one-off rule is about a *new*, unnamed local shell; an edited profile
    // keeps its own path through the save.
    expect(
      keepsConnectProfile({ kind: "local", name: "shell", existingId: "p-1", startup: "" }),
    ).toBe(true);
  });
});
