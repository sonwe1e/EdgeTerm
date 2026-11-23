import type { StateCreator } from "zustand";

import {
  MAX_COMMAND_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SNIPPETS,
  loadSnippets,
  saveSnippets,
  type Snippet,
} from "./snippets";
import type { AppStore } from "./storeTypes";

/**
 * Saved commands live in the store so every surface (the dialog, later the
 * palette) shares one list and one persistence point. Saving is upsert by
 * name: the reader who re-saves "restart nginx" means the same command, and
 * two rows with one name would be a puzzle.
 */
export const createSnippetActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<AppStore, "snippets" | "saveSnippet" | "deleteSnippet" | "replaceSnippet" | "importSnippets">
> = (set, get) => ({
  snippets: loadSnippets(),

  saveSnippet(name, command) {
    const trimmedName = name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, MAX_NAME_LENGTH);
    const trimmedCommand = command.slice(0, MAX_COMMAND_LENGTH);
    if (!trimmedName || !trimmedCommand.trim()) return;
    const snippets = get().snippets;
    const index = snippets.findIndex((item) => item.name === trimmedName);
    let next: Snippet[];
    if (index >= 0) {
      next = snippets.map((item, at) =>
        at === index ? { ...item, command: trimmedCommand } : item,
      );
    } else {
      if (snippets.length >= MAX_SNIPPETS) return;
      next = [...snippets, { id: crypto.randomUUID(), name: trimmedName, command: trimmedCommand }];
    }
    saveSnippets(next);
    set({ snippets: next });
  },

  replaceSnippet(id, name, command) {
    const snippets = get().snippets;
    const target = snippets.find((item) => item.id === id);
    if (!target) return false;
    const trimmedName = name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, MAX_NAME_LENGTH);
    const trimmedCommand = command.slice(0, MAX_COMMAND_LENGTH);
    if (!trimmedName || !trimmedCommand.trim()) return false;
    if (snippets.some((item) => item.id !== id && item.name === trimmedName)) return false;
    const next = snippets.map((item) =>
      item.id === id ? { ...item, name: trimmedName, command: trimmedCommand } : item,
    );
    saveSnippets(next);
    set({ snippets: next });
    return true;
  },

  importSnippets(entries) {
    let next = [...get().snippets];
    let landed = 0;
    for (const entry of entries) {
      const trimmedName = entry.name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
      const trimmedCommand = entry.command.slice(0, MAX_COMMAND_LENGTH);
      if (!trimmedName || !trimmedCommand.trim()) continue;
      const index = next.findIndex((item) => item.name === trimmedName);
      if (index >= 0) {
        next = next.map((item, at) => (at === index ? { ...item, command: trimmedCommand } : item));
      } else if (next.length < MAX_SNIPPETS) {
        next = [...next, { id: crypto.randomUUID(), name: trimmedName, command: trimmedCommand }];
      } else {
        continue;
      }
      landed += 1;
    }
    if (landed > 0) {
      saveSnippets(next);
      set({ snippets: next });
    }
    return landed;
  },

  deleteSnippet(id) {
    const next = get().snippets.filter((item) => item.id !== id);
    if (next.length === get().snippets.length) return;
    saveSnippets(next);
    set({ snippets: next });
  },
});
