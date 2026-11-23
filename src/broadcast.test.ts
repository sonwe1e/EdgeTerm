import { describe, expect, it } from "vitest";

import { broadcastTargets, canBroadcast, isTerminalResponse } from "./broadcast";
import type { SessionKind, SessionState } from "./types";

// The rule that decides where a keystroke goes when synchronized input is on.
// It is the one place a mistake reaches several machines at once, so every
// exclusion is pinned here.

const tab = (id: string, kind: SessionKind, state: SessionState = "connected") => ({
  info: { id, kind },
  state,
});

describe("broadcastTargets", () => {
  it("lists every other connected shell", () => {
    const tabs = [tab("a", "ssh"), tab("b", "local"), tab("c", "serial"), tab("d", "telnet")];
    expect(broadcastTargets(tabs, "a")).toEqual(["b", "c", "d"]);
    expect(canBroadcast(tabs, "a")).toBe(true);
  });

  it("never includes the session the reader is typing in", () => {
    expect(broadcastTargets([tab("a", "ssh")], "a")).toEqual([]);
    expect(canBroadcast([tab("a", "ssh")], "a")).toBe(false);
  });

  it("skips sessions that are not connected", () => {
    const tabs = [
      tab("a", "ssh"),
      tab("b", "ssh", "connecting"),
      tab("c", "ssh", "closed"),
      tab("d", "ssh", "error"),
    ];
    expect(broadcastTargets(tabs, "a")).toEqual([]);
  });

  it("skips file sessions, which have a browser rather than a shell", () => {
    const tabs = [tab("a", "ssh"), tab("b", "sftp"), tab("c", "ftp")];
    expect(broadcastTargets(tabs, "a")).toEqual([]);
  });

  it("keeps the tab order, so the same set always reports the same way", () => {
    const tabs = [tab("x", "ssh"), tab("a", "local"), tab("y", "ssh"), tab("b", "ssh")];
    expect(broadcastTargets(tabs, "x")).toEqual(["a", "y", "b"]);
  });

  it("skips the sessions the reader unchecked", () => {
    const tabs = [tab("a", "ssh"), tab("b", "ssh"), tab("c", "local")];
    expect(broadcastTargets(tabs, "a", ["b"])).toEqual(["c"]);
    expect(broadcastTargets(tabs, "a", ["b", "c"])).toEqual([]);
    expect(canBroadcast(tabs, "a", ["b", "c"])).toBe(false);
  });

  it("has no targets without a source session", () => {
    expect(broadcastTargets([tab("a", "ssh"), tab("b", "ssh")], null)).toEqual([]);
    expect(canBroadcast([tab("a", "ssh")], null)).toBe(false);
  });

  it("leaves a whole excluded group out and keeps everyone else", () => {
    const tabs = [
      tab("a", "ssh"),
      { ...tab("b", "ssh"), profile: { groupId: "prod" } },
      { ...tab("c", "ssh"), profile: { groupId: "prod" } },
      { ...tab("d", "ssh"), profile: { groupId: "lab" } },
      tab("e", "ssh"),
    ];
    expect(broadcastTargets(tabs, "a", [], ["prod"])).toEqual(["d", "e"]);
    expect(broadcastTargets(tabs, "a", ["e"], ["prod"])).toEqual(["d"]);
    expect(broadcastTargets(tabs, "a", [], ["prod", "lab"])).toEqual(["e"]);
    expect(canBroadcast(tabs, "a", ["e"], ["prod", "lab"])).toBe(false);
  });

  it("does not hide a session whose group is unknown to the exclusion list", () => {
    const tabs = [
      tab("a", "ssh"),
      { ...tab("b", "ssh"), profile: { groupId: "prod" } },
      tab("c", "ssh"),
    ];
    expect(broadcastTargets(tabs, "a", [], ["elsewhere"])).toEqual(["b", "c"]);
    expect(broadcastTargets(tabs, "a", [], [])).toEqual(["b", "c"]);
  });
});
describe("isTerminalResponse", () => {
  it("recognises the reports xterm sends on the typing channel", () => {
    for (const report of [
      "\x1b[?1;2c",
      "\x1b[>1;10;0c",
      "\x1b[0n",
      "\x1b[12;40R",
      "\x1b[>0;276;0c",
      "\x1bP1+r544e\x1b\\",
    ]) {
      expect(isTerminalResponse(report), report).toBe(true);
    }
  });

  it("never mistakes a typed key, paste or shell command for a report", () => {
    for (const input of ["a", "\r", "\x1b[A", "\x1b[1;5C", "ls -l\r", "\x1b[200~pasted\x1b[201~"]) {
      expect(isTerminalResponse(input), JSON.stringify(input)).toBe(false);
    }
  });
});
