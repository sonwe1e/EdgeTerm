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
