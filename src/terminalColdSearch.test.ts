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
    historySearch.mockResolvedValue([
      { absLine: 412, column: 8 },
      { absLine: 407, column: 0 },
    ]);
    const outcome = await searchColdHistory("session-1", "needle", plain);
    expect(historySearch).toHaveBeenCalledTimes(1);
    expect(historySearch).toHaveBeenCalledWith(
      "session-1",
      "needle",
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
    );
    expect(outcome).toEqual({ count: 2, newestAbsLine: 412 });
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
    });
    historySearch.mockResolvedValue([]);
    expect(await searchColdHistory("session-1", "needle", plain)).toEqual({
      count: 0,
      newestAbsLine: null,
    });
  });
});
