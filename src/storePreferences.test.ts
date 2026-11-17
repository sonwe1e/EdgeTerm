import { expect, it } from "vitest";

import { TERMINAL_COLD_HISTORY_KEY as registered } from "./persistKeys";
import { TERMINAL_COLD_HISTORY_KEY } from "./storePreferences";

// The literal used to be written twice — once here, once in persistKeys, where
// settings reset and export read it. They agree today because one is a
// re-export; this fails if a second literal is ever added back.
it("uses the same cold-history key as the settings registry", () => {
  expect(TERMINAL_COLD_HISTORY_KEY).toBe(registered);
});
