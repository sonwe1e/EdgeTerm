import { beforeEach, describe, expect, it } from "vitest";

import { SNIPPETS_STORAGE_KEY, STARTUP_COMMANDS_STORAGE_KEY } from "./persistKeys";
import { useStore } from "./store";

/**
 * Saved commands and startup commands are preferences the reader wrote, so
 * they travel with a settings export, come back on import at once, and are
 * cleared by "restore default settings" — the registry in persistKeys.ts is
 * what makes all three true.
 */

describe("settings carry the commands a reader wrote", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ snippets: [], startupCommands: {} });
  });

  it("exports both under preferences", () => {
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().setStartupCommand("p1", "cd /srv/app");
    const exported = useStore.getState().exportSettings() as {
      preferences: Record<string, unknown>;
    };
    expect(exported.preferences[SNIPPETS_STORAGE_KEY]).toEqual([
      expect.objectContaining({ name: "Logs", command: "tail -f app.log" }),
    ]);
    expect(exported.preferences[STARTUP_COMMANDS_STORAGE_KEY]).toEqual({ p1: "cd /srv/app" });
  });

  it("applies an imported copy to storage and to the store at once", () => {
    useStore.getState().applySettings({
      preferences: {
        [SNIPPETS_STORAGE_KEY]: [{ id: "s1", name: "Deploy", command: "deploy prod" }],
        [STARTUP_COMMANDS_STORAGE_KEY]: { p2: "tmux attach" },
      },
    });
    expect(useStore.getState().snippets).toEqual([
      { id: "s1", name: "Deploy", command: "deploy prod" },
    ]);
    expect(useStore.getState().startupCommands).toEqual({ p2: "tmux attach" });
    expect(JSON.parse(localStorage.getItem(SNIPPETS_STORAGE_KEY)!)[0].name).toBe("Deploy");
  });

  it("restores defaults by emptying both", () => {
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    useStore.getState().setStartupCommand("p1", "cd /srv/app");
    useStore.getState().resetSettings();
    expect(localStorage.getItem(SNIPPETS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(STARTUP_COMMANDS_STORAGE_KEY)).toBeNull();
    expect(useStore.getState().snippets).toEqual([]);
    expect(useStore.getState().startupCommands).toEqual({});
  });
});
