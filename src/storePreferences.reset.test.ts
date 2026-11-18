import { expect, it } from "vitest";

import { useStore } from "./store";
import * as preferences from "./storePreferences";

// Every preference this module defines is a bare localStorage entry that the
// reset path clears by hand, one `removeItem` at a time. A key added here and
// forgotten there means "restore default settings" silently leaves that
// preference alone — the user resets, and one setting quietly stays changed.
const PREFERENCE_KEYS = Object.entries(preferences)
  .filter(([name, value]) => name.endsWith("_KEY") && typeof value === "string")
  .map(([, value]) => value as string);

const MARKER = "__seeded__";

it("restores every preference this module defines", async () => {
  // A guard on the guard: if the export naming ever changes, this test would
  // otherwise pass by finding no keys at all.
  expect(PREFERENCE_KEYS.length).toBeGreaterThanOrEqual(22);

  for (const key of PREFERENCE_KEYS) localStorage.setItem(key, MARKER);

  await useStore.getState().resetSettings();

  const survived = PREFERENCE_KEYS.filter((key) => localStorage.getItem(key) === MARKER);
  expect(survived).toEqual([]);
  localStorage.clear();
});
