import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { TERMINAL_COLD_HISTORY_KEY } from "./storePreferences";
import { COLD_SEARCH_BUDGET_MS, COLD_SEARCH_LIMIT, searchColdHistory } from "./terminalColdSearch";

vi.mock("./bindings", () => ({
  commands: { historySearchBefore: vi.fn() },
}));

const historySearchBefore = vi.mocked(commands.historySearchBefore);
const plain = { regex: false, wholeWord: false, caseSensitive: true };

const enableColdHistory = () => window.localStorage.setItem(TERMINAL_COLD_HISTORY_KEY, "1");

afterEach(() => {
  window.localStorage.clear();
  historySearchBefore.mockReset();
});

describe("searchColdHistory", () => {
  it("queries the cold store with the contract shape, newest hit first", async () => {
    enableColdHistory();
    historySearchBefore.mockResolvedValue([
      { absLine: 412, column: 8 },
      { absLine: 407, column: 0 },
    ]);
    const outcome = await searchColdHistory("session-1", "needle", plain, 500);
    expect(historySearchBefore).toHaveBeenCalledTimes(1);
    expect(historySearchBefore).toHaveBeenCalledWith(
      "session-1",
      "needle",
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
      500,
    );
    expect(outcome).toEqual({ count: 2, newestAbsLine: 412 });
  });

  it("uses the Rust exclusive bound before its 200-hit limit", async () => {
    enableColdHistory();
    // Two hundred newer hits could still be in xterm. Rust must skip them
    // before applying its hit limit, leaving these 50 genuinely cold hits.
    const coldHits = Array.from({ length: 50 }, (_, index) => ({
      absLine: 450 - index,
      column: 1,
    }));
    historySearchBefore.mockResolvedValue(coldHits);
    const outcome = await searchColdHistory("session-1", "needle", plain, 500);
    expect(historySearchBefore).toHaveBeenCalledWith(
      "session-1",
      "needle",
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
      500,
    );
    expect(outcome).toEqual({ count: 50, newestAbsLine: 450 });
  });

  it("skips cold search without a reliable hot-buffer boundary", async () => {
    enableColdHistory();
    for (const boundary of [undefined, null, 0, 1, -1, NaN, 1.5, Infinity]) {
      expect(await searchColdHistory("session-1", "needle", plain, boundary)).toEqual({
        count: 0,
        newestAbsLine: null,
      });
    }
    expect(historySearchBefore).not.toHaveBeenCalled();
  });

  it("skips regex and whole-word queries rather than miscounting them", async () => {
    enableColdHistory();
    await searchColdHistory(
      "session-1",
      "needle",
      {
        regex: true,
        wholeWord: false,
        caseSensitive: true,
      },
      500,
    );
    await searchColdHistory(
      "session-1",
      "needle",
      {
        regex: false,
        wholeWord: true,
        caseSensitive: true,
      },
      500,
    );
    // The store matches case literally; an insensitive buffer search would
    // count a different rule, so it stays out of the number.
    await searchColdHistory(
      "session-1",
      "needle",
      {
        regex: false,
        wholeWord: false,
        caseSensitive: false,
      },
      500,
    );
    expect(historySearchBefore).not.toHaveBeenCalled();
  });

  it("stays quiet while the cold history preference is off", async () => {
    await searchColdHistory("session-1", "needle", plain, 500);
    expect(historySearchBefore).not.toHaveBeenCalled();
  });

  it("ignores an empty needle", async () => {
    enableColdHistory();
    await searchColdHistory("session-1", "", plain, 500);
    expect(historySearchBefore).not.toHaveBeenCalled();
  });

  it("reports zero when the request fails or finds nothing", async () => {
    enableColdHistory();
    historySearchBefore.mockRejectedValue(new Error("store gone"));
    expect(await searchColdHistory("session-1", "needle", plain, 500)).toEqual({
      count: 0,
      newestAbsLine: null,
    });
    historySearchBefore.mockResolvedValue([]);
    expect(await searchColdHistory("session-1", "needle", plain, 500)).toEqual({
      count: 0,
      newestAbsLine: null,
    });
  });
});
