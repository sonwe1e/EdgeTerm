import { describe, expect, it } from "vitest";

import { translate, type Translate } from "./i18n";
import {
  MAC_DEFAULTS,
  OTHER_DEFAULTS,
  SHORTCUT_COMMANDS,
  chordLabel,
  sameChord,
  shortcutHints,
  shortcutLabels,
  type ShortcutBindings,
} from "./shortcuts";

/** The English catalog is the source of truth, so the census reads it directly. */
const en: Translate = (key, params) => translate("en", key, params);
const ids = SHORTCUT_COMMANDS.map((command) => command.id);

describe("the shortcut table", () => {
  it("names and explains every command the settings dialog can list", () => {
    const labels = shortcutLabels(en);
    const hints = shortcutHints(en);
    for (const id of ids) {
      expect(labels[id], `label for ${id}`).toBeTruthy();
      expect(labels[id], `label for ${id} is not a raw key`).not.toBe(`sc.${id}.label`);
      expect(hints[id], `hint for ${id}`).toBeTruthy();
      expect(hints[id], `hint for ${id} is not a raw key`).not.toBe(`sc.${id}.hint`);
    }
  });

  it("lists each command once, so the dialog has one row per action", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never gives two commands the same default chord on a platform", () => {
    const platforms: [string, Readonly<ShortcutBindings>][] = [
      ["mac", MAC_DEFAULTS],
      ["other", OTHER_DEFAULTS],
    ];
    for (const [name, defaults] of platforms) {
      const taken: string[] = [];
      for (const id of ids) {
        const chord = defaults[id];
        if (!chord) continue;
        const label = chordLabel(chord);
        expect(label, `${name} label for ${id}`).toBeTruthy();
        expect(taken, `${name}: ${id} reuses ${label}`).not.toContain(label);
        taken.push(label);
      }
    }
  });

  it("keeps the two platform tables in step: a chord held on one, held on the other", () => {
    for (const id of ids) {
      const mac = MAC_DEFAULTS[id];
      const other = OTHER_DEFAULTS[id];
      expect(Boolean(mac), `mac default for ${id}`).toBe(Boolean(other));
      if (mac && other) expect(sameChord(mac, mac)).toBe(true);
    }
  });
});
