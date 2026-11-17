import { expect, it } from "vitest";

import { formatBytes, formatDate, joinRemote } from "./ftpPresentation";

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

it("formats sizes the way the Filer column does", () => {
  expect(formatBytes(1024)).toBe("1.0 KB");
  // 1048570 bytes is 1023.99 KB: this copy of the rounding printed "1024 KB"
  // while the Filer printed "1.0 MB" for the same file.
  expect(formatBytes(1048570)).toBe("1.0 MB");
});

it("joins a remote path the way the Filer does, collapsing extra separators", () => {
  expect(joinRemote("/", "a")).toBe("/a");
  expect(joinRemote("/srv", "a")).toBe("/srv/a");
  // The Filer's own copy kept the doubled slash; this one collapsed it.
  expect(joinRemote("/srv//", "a")).toBe("/srv/a");
});
