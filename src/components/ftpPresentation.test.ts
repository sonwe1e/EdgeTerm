import { expect, it } from "vitest";

import { formatDate } from "./ftpPresentation";

// The FTP column used to print the machine's full locale date, so a row read
// "2026/11/18 14:32" beside the Filer's "11-18 14:32" — a different order, and
// a different width for the same column in two lists that sit side by side.
it("prints the Filer's width-stable shape, not the machine's locale date", () => {
  const shown = formatDate(Date.UTC(2026, 10, 18, 6, 32) / 1000);

  expect(shown).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$|^\d{4}-\d{2}-\d{2}$/);
  expect(shown).not.toContain("/");
});

it("still says the moment is unknown rather than printing nothing", () => {
  expect(formatDate(null)).toBe("Unknown");
});
