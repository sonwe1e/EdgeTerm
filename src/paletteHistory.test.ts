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

describe("command history in the palette", () => {
  it("lists recent commands as rows the reader can run", () => {
    const sendHistory = vi.fn();
    const commands = buildPaletteCommands(
      sources({
        history: [
          { command: "kubectl get pods", host: "ssh:ops@box" },
          { command: "git status", host: "ssh:dev@box" },
        ],
        actions: { ...sources().actions, sendHistory },
      }),
    );
    const rows = commands.filter((command) => command.id.startsWith("history:"));
    expect(rows.map((row) => row.label)).toEqual(["kubectl get pods", "git status"]);
    expect(rows[0].hint, "the row says where it ran").toBe("ssh:ops@box");
    expect(rows[0].keywords).toContain("history");
    rows[0].run();
    expect(sendHistory).toHaveBeenCalledWith("kubectl get pods");
  });

  it("offers nothing when history is off", () => {
    const commands = buildPaletteCommands(sources());
    expect(commands.some((command) => command.id.startsWith("history:"))).toBe(false);
  });
});
