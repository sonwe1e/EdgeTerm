import { describe, expect, it } from "vitest";

import { historyCountLabel } from "./components/SearchOverlay";
import { COLD_SEARCH_LIMIT } from "./terminalColdSearch";

// The cold search stops at COLD_SEARCH_LIMIT hits, so a full count is a lower
// bound: the panel says "200+" rather than claiming an exact total.
describe("historyCountLabel", () => {
  it("shows an exact count below the cap", () => {
    expect(historyCountLabel(1)).toBe(1);
    expect(historyCountLabel(COLD_SEARCH_LIMIT - 1)).toBe(COLD_SEARCH_LIMIT - 1);
  });

  it("marks a full sweep as a lower bound", () => {
    expect(historyCountLabel(COLD_SEARCH_LIMIT)).toBe(`${COLD_SEARCH_LIMIT}+`);
    expect(historyCountLabel(COLD_SEARCH_LIMIT * 3)).toBe(`${COLD_SEARCH_LIMIT}+`);
  });
});
