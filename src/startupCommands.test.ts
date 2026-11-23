import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_STARTUP_PROFILES,
  STARTUP_COMMANDS_KEY,
  loadStartupCommands,
  parseStartupCommands,
  saveStartupCommands,
  startupLine,
} from "./startupCommands";
import { useStore } from "./store";

describe("startup commands", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ startupCommands: {} });
  });

  it("keeps the first non-empty line", () => {
    expect(startupLine("  cd /srv/app  ")).toBe("cd /srv/app");
    expect(startupLine("\n\n tmux attach \n echo hi")).toBe("tmux attach");
    expect(startupLine("   ")).toBe("");
  });

  it("drops anything a hand-edited file could break", () => {
    expect(parseStartupCommands(null)).toEqual({});
    expect(parseStartupCommands("not json")).toEqual({});
    expect(parseStartupCommands("[]")).toEqual({});
    expect(parseStartupCommands(JSON.stringify({ a: " ls ", b: 3, c: "  ", d: "x\ny" }))).toEqual({
      a: "ls",
      d: "x",
    });
  });

  it("stops at the profile cap", () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < MAX_STARTUP_PROFILES + 5; index += 1) many["p" + index] = "ls";
    expect(Object.keys(parseStartupCommands(JSON.stringify(many)))).toHaveLength(
      MAX_STARTUP_PROFILES,
    );
  });

  it("round-trips through storage", () => {
    saveStartupCommands({ p1: "cd /srv/app" });
    expect(JSON.parse(localStorage.getItem(STARTUP_COMMANDS_KEY)!)).toEqual({ p1: "cd /srv/app" });
    expect(loadStartupCommands()).toEqual({ p1: "cd /srv/app" });
  });

  it("stores and clears a profile command through the store", () => {
    useStore.getState().setStartupCommand("p1", " tmux attach ");
    expect(useStore.getState().startupCommands).toEqual({ p1: "tmux attach" });
    expect(JSON.parse(localStorage.getItem(STARTUP_COMMANDS_KEY)!)).toEqual({ p1: "tmux attach" });
    useStore.getState().setStartupCommand("p1", "   ");
    expect(useStore.getState().startupCommands).toEqual({});
    expect(JSON.parse(localStorage.getItem(STARTUP_COMMANDS_KEY)!)).toEqual({});
  });
});
