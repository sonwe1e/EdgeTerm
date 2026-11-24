import { describe, expect, it, vi } from "vitest";

import { buildPaletteCommands, type PaletteSources } from "./commandPalette";
import { translate } from "./i18n";
import { defaultShortcuts } from "./shortcuts";

const sources = (overrides: Partial<PaletteSources> = {}): PaletteSources => ({
  t: (key, params) => translate("en", key, params),
  shortcuts: defaultShortcuts(),
  tabs: [],
  profiles: [],
  theme: "dark",
  actions: {
    runShortcut: () => {},
    activateTab: () => {},
    connectProfile: () => {},
    setTheme: () => {},
    openDisplaySettings: () => {},
    openShortcutSettings: () => {},
    openSettings: () => {},
    openAbout: () => {},
    checkForUpdates: () => {},
  },
  ...overrides,
});

describe("saved commands in the palette", () => {
  it("lists one entry per snippet, searchable by its own text", () => {
    const sendSnippet = vi.fn();
    const commands = buildPaletteCommands(
      sources({
        snippets: [{ id: "s1", name: "Logs", command: "tail -f app.log" }],
        actions: { ...sources().actions, sendSnippet },
      }),
    );
    const entry = commands.find((command) => command.id === "snippet:s1");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Send Logs");
    expect(entry!.hint).toBe("tail -f app.log");
    expect(entry!.keywords).toContain("tail -f app.log");
    expect(entry!.group).toBe("actions");
    entry!.run();
    expect(sendSnippet).toHaveBeenCalledWith("s1");
  });

  it("offers to save the last command when the caller can", () => {
    const saveLastCommandAsSnippet = vi.fn();
    const commands = buildPaletteCommands(
      sources({ actions: { ...sources().actions, saveLastCommandAsSnippet } }),
    );
    const entry = commands.find((command) => command.id === "snippet:save-last");
    expect(entry).toBeDefined();
    entry!.run();
    expect(saveLastCommandAsSnippet).toHaveBeenCalled();
  });

  it("adds nothing when the caller has no snippet support", () => {
    const commands = buildPaletteCommands(sources());
    expect(commands.some((command) => command.id.startsWith("snippet:"))).toBe(false);
  });

  it("opens the manager when the caller can", () => {
    const openSnippetsDialog = vi.fn();
    const commands = buildPaletteCommands(
      sources({ actions: { ...sources().actions, openSnippetsDialog } }),
    );
    const entry = commands.find((command) => command.id === "snippet:manage");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Saved Commands");
    entry!.run();
    expect(openSnippetsDialog).toHaveBeenCalled();
  });
});
