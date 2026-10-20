import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../types";
import {
  entryDateStamp,
  entryTitle,
  formatBytes,
  formatDate,
  formatDateParts,
  rowLocale,
} from "./filerPresentation";

/** Local wall-clock second; the assertions below are timezone-independent. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 5).getTime() / 1000;

const NOW = new Date(2025, 9, 20, 14, 32, 0);

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: "file.txt",
  path: "/selection/file.txt",
  isDir: false,
  isSymlink: false,
  size: 10,
  modified: 1,
  permissions: null,
  owner: null,
  group: null,
  ...over,
});

describe("formatBytes", () => {
  it("promotes a size whose rounded value crosses into the next unit", () => {
    // 1023.95 KB: the old implementation rounded first and printed 1024 KB,
    // which is neither the right unit nor even a width the column can hold.
    expect(formatBytes(Math.round(1023.95 * 1024))).toBe("1.0 MB");
    // 1023.5 KB is 1047552 bytes, still short of a megabyte: only a value
    // that rounds past 1024 of its own unit moves up.
    expect(formatBytes(1023.5 * 1024)).toBe("1023.5 KB");
  });

  it("keeps one decimal in every unit above the byte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(30)).toBe("30 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2 * 12 + 1024 ** 2 / 2)).toBe("12.5 MB");
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB");
  });

  it("never renders more characters than the column reserves", () => {
    const samples = [0, 1, 999, 1024, 1023.9 * 1024, 1024 ** 3, 1024 ** 5 - 1, 1024 ** 6];
    for (const sample of samples) {
      expect(formatBytes(sample).length).toBeLessThanOrEqual(9);
    }
  });

  it("prints a dash for a size it cannot read", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatDate", () => {
  // Today is the one row allowed a word, and it is the one a user scans for:
  // a bare `14:32` is the same shape as the `10-20` on the rows beside it.
  // Everything else is numbers, in every language, so the column stays one
  // width — which is what makes a fixed track possible at all.
  it("names today and reduces the rest of the year to a day and a time", () => {
    expect(formatDate(at(2025, 10, 20, 9, 5), "en-US", NOW)).toBe("Today 09:05");
    expect(formatDate(at(2025, 10, 20, 23, 59), "en-US", NOW)).toBe("Today 23:59");
    expect(formatDate(at(2025, 10, 19, 22, 30), "en-US", NOW)).toBe("10-19 22:30");
    expect(formatDate(at(2025, 10, 19, 0, 1), "zh-CN", NOW)).toBe("10-19 00:01");
    expect(formatDate(at(2025, 1, 5, 8), "en-US", NOW)).toBe("01-05 08:00");
  });

  it("splits today's cell so the clock time can take the fainter ink", () => {
    expect(formatDateParts(at(2025, 10, 20, 9, 5), "en-US", NOW)).toEqual({
      value: "Today",
      time: "09:05",
    });
    // A date old enough to name its year has no time to split off.
    expect(formatDateParts(at(2023, 12, 31, 23, 59), "en-US", NOW)).toEqual({
      value: "2023-12-31",
      time: "",
    });
  });

  it("keeps the year once the date is out of the year on screen", () => {
    expect(formatDate(at(2023, 12, 31, 23, 59), "en-US", NOW)).toBe("2023-12-31");
    expect(formatDate(at(2023, 12, 31, 23, 59), "zh-CN", NOW)).toBe("2023-12-31");
  });

  // A missing time is not the epoch, and it is not an empty cell either:
  // the listing was asked for a moment and did not give one, which is worth
  // one word. A folder's size is the other case — absent by category — and it
  // gets nothing at all.
  it("separates an unknown time from the epoch itself", () => {
    expect(formatDate(null, "en-US", NOW)).toBe("Unknown");
    expect(formatDate(0, "en-US", NOW)).toBe("1970-01-01");
  });

  // A server whose clock runs ahead dates files in the future. Those fall
  // back to a plain day instead of printing a moment that has not happened,
  // and they keep the year off so the column stays one width.
  it("dates a file whose server clock runs ahead as a plain day", () => {
    expect(formatDate(at(2025, 10, 22, 8), "en-US", NOW)).toBe("10-22 08:00");
  });

  // The column is a fixed width and that is the whole point of the numbers:
  // no locale may change it. Only the word for today still carries a language.
  it("prints one width in every locale", () => {
    const stamp = at(2025, 6, 1, 8);
    expect(formatDate(stamp, "en-US", NOW)).toBe("06-01 08:00");
    expect(formatDate(stamp, "de-DE", NOW)).toBe("06-01 08:00");
    expect(formatDate(stamp, "zh-CN", NOW)).toBe("06-01 08:00");
  });
});

describe("entryDateStamp", () => {
  // SFTP hands over a bare count of seconds with no zone at all, so the
  // tooltip has to say whose clock it read them in.
  it("carries the seconds and the zone the timestamp was read in", () => {
    const stamp = entryDateStamp(at(2025, 10, 20, 14, 32));
    // The zone alone is not enough: it has to say whose zone it is. A remote
    // mtime carries none, so naming +08:00 without "this device" leaves it
    // looking like the server's time.
    expect(stamp).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}/);
    expect(stamp).toMatch(/this device|本机/);
    expect(stamp).not.toBe(formatDate(at(2025, 10, 20, 14, 32), "en-US", NOW));
  });

  it("is empty rather than a dash inside the tooltip's own line", () => {
    expect(entryDateStamp(null)).toBe("");
  });
});

describe("entryTitle", () => {
  it("puts the full timestamp on a line the row cannot clip", () => {
    const lines = entryTitle(entry({ modified: at(2025, 10, 20, 14, 32) })).split("\n");
    expect(lines[0]).toBe("/selection/file.txt");
    expect(lines[2]).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("leaves the timestamp out when the listing has no time", () => {
    expect(entryTitle(entry({ modified: null })).split("\n")).toHaveLength(2);
  });
});

describe("rowLocale", () => {
  it("reads the interface language off <html>", () => {
    document.documentElement.lang = "zh-CN";
    expect(rowLocale()).toBe("zh-CN");
    document.documentElement.lang = "";
    expect(rowLocale()).toBeUndefined();
  });
});
