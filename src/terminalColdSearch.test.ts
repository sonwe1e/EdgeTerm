import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { TERMINAL_COLD_HISTORY_KEY } from "./storePreferences";
import { COLD_SEARCH_BUDGET_MS, COLD_SEARCH_LIMIT, searchColdHistory } from "./terminalColdSearch";

vi.mock("./bindings", () => ({
  commands: { historySearch: vi.fn() },
}));

const historySearch = vi.mocked(commands.historySearch);
const plain = { regex: false, wholeWord: false, caseSensitive: true };

const enableColdHistory = () => window.localStorage.setItem(TERMINAL_COLD_HISTORY_KEY, "1");

afterEach(() => {
  window.localStorage.clear();
  historySearch.mockReset();
});

describe("searchColdHistory", () => {
  it("queries the cold store with the contract shape, newest hit first", async () => {
    enableColdHistory();
    historySearch.mockResolvedValue({
      hits: [
        { absLine: 412, column: 8 },
        { absLine: 407, column: 0 },
      ],
      truncated: false,
    });
    const outcome = await searchColdHistory("session-1", "needle", plain);
    expect(historySearch).toHaveBeenCalledTimes(1);
    expect(historySearch).toHaveBeenCalledWith(
      "session-1",
      "needle",
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
    );
    expect(outcome).toEqual({ count: 2, newestAbsLine: 412, truncated: false, skipped: null });
  });

  it("carries the store's truncated flag so the count reads as a lower bound", async () => {
    enableColdHistory();
    // A spent budget leaves blocks unchecked: the count is not a total, and
    // printing it as one would stop the reader looking for more.
    historySearch.mockResolvedValue({
      hits: [{ absLine: 90, column: 1 }],
      truncated: true,
    });
    expect(await searchColdHistory("session-1", "needle", plain)).toEqual({
      count: 1,
      newestAbsLine: 90,
      truncated: true,
      skipped: null,
    });
  });

  it("skips regex and whole-word queries rather than miscounting them", async () => {
    enableColdHistory();
    await searchColdHistory("session-1", "needle", {
      regex: true,
      wholeWord: false,
      caseSensitive: true,
    });
    await searchColdHistory("session-1", "needle", {
      regex: false,
      wholeWord: true,
      caseSensitive: true,
    });
    // The store matches case literally; an insensitive buffer search would
    // count a different rule, so it stays out of the number.
    await searchColdHistory("session-1", "needle", {
      regex: false,
      wholeWord: false,
      caseSensitive: false,
    });
    expect(historySearch).not.toHaveBeenCalled();
  });

  it("stays quiet while the cold history preference is off", async () => {
    await searchColdHistory("session-1", "needle", plain);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it("ignores an empty needle", async () => {
    enableColdHistory();
    await searchColdHistory("session-1", "", plain);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it("reports zero when the request fails or finds nothing", async () => {
    enableColdHistory();
    historySearch.mockRejectedValue(new Error("store gone"));
    expect(await searchColdHistory("session-1", "needle", plain)).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: null,
    });
    historySearch.mockResolvedValue({ hits: [], truncated: false });
    expect(await searchColdHistory("session-1", "needle", plain)).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: null,
    });
  });

  it("says why the store was left unasked, so a zero count is not read as none", async () => {
    enableColdHistory();
    // The box opens case-insensitive, which is the default and the common
    // case: without the reason, "no results" looks like "the history has
    // none" and the older-matches hint never appears.
    expect(
      await searchColdHistory("session-1", "needle", {
        regex: false,
        wholeWord: false,
        caseSensitive: false,
      }),
    ).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: "case",
    });
    expect(
      await searchColdHistory("session-1", "needle", {
        regex: true,
        wholeWord: false,
        caseSensitive: true,
      }),
    ).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: "regex",
    });
    expect(
      await searchColdHistory("session-1", "needle", {
        regex: false,
        wholeWord: true,
        caseSensitive: true,
      }),
    ).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: "wholeWord",
    });
  });

  it("reports the preference as the reason while cold history is off", async () => {
    expect(await searchColdHistory("session-1", "needle", plain)).toEqual({
      count: 0,
      newestAbsLine: null,
      truncated: false,
      skipped: "off",
    });
  });
});
