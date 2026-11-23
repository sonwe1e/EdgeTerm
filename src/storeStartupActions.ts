import type { StateCreator } from "zustand";

import { loadStartupCommands, saveStartupCommands, startupLine } from "./startupCommands";
import type { AppStore } from "./storeTypes";

/**
 * Startup commands keyed by profile id. They live with the other preferences,
 * not inside a profile, so a profile written by an older build still loads.
 */
export const createStartupActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<AppStore, "startupCommands" | "setStartupCommand">
> = (set, get) => ({
  startupCommands: loadStartupCommands(),

  setStartupCommand(profileId, command) {
    if (!profileId) return;
    const line = startupLine(command);
    const current = get().startupCommands;
    const next = { ...current };
    if (line) next[profileId] = line;
    else delete next[profileId];
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    saveStartupCommands(next);
    set({ startupCommands: next });
  },
});
