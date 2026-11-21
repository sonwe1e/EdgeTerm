import { expect, it } from "vitest";

import { DEFAULT_SHORTCUTS, parseShortcuts, sameChord } from "./shortcuts";

// A chord one of the platform defaults already uses.
const taken = DEFAULT_SHORTCUTS.findNext!;

// A table the user imported or hand-edited mentions only the commands it
// changes. Merging it over the defaults must not let a command it never
// mentions take the chord an explicit entry asks for — that drops the user's
// own binding and then saves the loss back to storage.
it("lets an imported binding win over a default it collides with", () => {
  const imported = parseShortcuts({ find: { ...taken } }, DEFAULT_SHORTCUTS)!;

  expect(sameChord(imported.find, taken)).toBe(true);
  // Whoever held the chord gives it up, the way a reassignment in the dialog does.
  expect(imported.findNext).toBeNull();
});

it("drops a stored binding the dialog would have refused", () => {
  const menuKey = { ctrl: false, alt: false, shift: true, meta: false, code: "F10" };
  const imported = parseShortcuts(
    {
      find: menuKey,
      findNext: { ctrl: false, alt: false, shift: false, meta: false, code: "KeyJ" },
    },
    DEFAULT_SHORTCUTS,
  )!;

  // Both are refused in the dialog: the menu key and a bare key. The refused
  // entries are dropped, and the commands keep the bindings they already had.
  expect(imported.find).toEqual(DEFAULT_SHORTCUTS.find);
  expect(imported.findNext).toEqual(DEFAULT_SHORTCUTS.findNext);
});

it("leaves the defaults alone when the table mentions nothing that collides", () => {
  const imported = parseShortcuts({ find: { ...taken } }, DEFAULT_SHORTCUTS)!;
  const untouched = Object.entries(DEFAULT_SHORTCUTS).filter(
    ([id, chord]) => id !== "find" && id !== "findNext" && chord !== null,
  );
  for (const [id, chord] of untouched) {
    expect(sameChord((imported as Record<string, typeof chord>)[id], chord)).toBe(true);
  }
  expect(imported.findNext).toBeNull();
  expect(sameChord(imported.find, taken)).toBe(true);
});

it("never lets an unusable entry take the chord a usable one asks for", () => {
  // `find` is malformed (no modifiers) and keeps its default chord; `findNext`
  // asks for that same chord. The broken entry must not claim anything, so the
  // usable one gets the chord.
  const claimed = DEFAULT_SHORTCUTS.find!;
  const imported = parseShortcuts(
    { find: { code: "KeyF" }, findNext: { ...claimed } },
    DEFAULT_SHORTCUTS,
  )!;

  expect(sameChord(imported.findNext, claimed)).toBe(true);
  expect(imported.find).toBeNull();
});

it.each([false, true])("reserves F6 for focus cycling in stored bindings (shift: %s)", (shift) => {
  const focusChord = { ...DEFAULT_SHORTCUTS.focusRegion!, shift };
  const imported = parseShortcuts({ find: focusChord }, DEFAULT_SHORTCUTS)!;
  expect(imported.find).toEqual(DEFAULT_SHORTCUTS.find);
  expect(imported.focusRegion).toEqual(DEFAULT_SHORTCUTS.focusRegion);

  const modified = { ...focusChord, ctrl: true };
  expect(parseShortcuts({ find: modified }, DEFAULT_SHORTCUTS)?.find).toEqual(modified);
  expect(parseShortcuts({ focusRegion: focusChord }, DEFAULT_SHORTCUTS)?.focusRegion).toEqual(
    focusChord,
  );
});
