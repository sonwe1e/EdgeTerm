import { commands } from "./bindings";
import { terminalColdHistoryEnabled } from "./storePreferences";

/** Cap and budget from the A2 find contract (D14); hits come newest-first. */
export const COLD_SEARCH_LIMIT = 200;
export const COLD_SEARCH_BUDGET_MS = 2000;

export interface ColdSearchOutcome {
  /** Hits in the cold store, capped at COLD_SEARCH_LIMIT. */
  count: number;
  /** The newest hit's absolute line, kept for a future jump-to-hit. */
  newestAbsLine: number | null;
  /**
   * Whether the scan stopped early - at the hit limit or the time budget -
   * so more matches may exist that this count does not include.
   */
  truncated: boolean;
  /**
   * Why the store was not asked, when it was not. A zero count with this
   * set means "not searched", not "nothing there" - and the reader can
   * usually do something about it.
   */
  skipped: "case" | "wholeWord" | "regex" | "off" | null;
}

/**
 * Counts `needle` in a session's cold history for the find box (roadmap
 * A2-7). Plain, case-sensitive substring queries only: the store searches
 * literal needles, so regex, whole-word, and case-insensitive queries would
 * count against a different rule than the buffer search and mislead. The
 * box starts case-insensitive, which is the common case, so the reason a
 * store was left unasked travels with the zero count - otherwise "no
 * results" reads as "the history has none" and the hint that older
 * matches exist never appears. A disabled cold history or a failed request
 * reports zero rather than disturbing the box.
 */
export async function searchColdHistory(
  sessionId: string,
  needle: string,
  options: { regex: boolean; wholeWord: boolean; caseSensitive: boolean },
): Promise<ColdSearchOutcome> {
  const none = (skipped: ColdSearchOutcome["skipped"] = null): ColdSearchOutcome => ({
    count: 0,
    newestAbsLine: null,
    truncated: false,
    skipped,
  });
  if (!needle) return none();
  if (options.regex) return none("regex");
  if (options.wholeWord) return none("wholeWord");
  if (!options.caseSensitive) return none("case");
  if (!terminalColdHistoryEnabled()) return none("off");
  try {
    const hits = await commands.historySearch(
      sessionId,
      needle,
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
    );
    return {
      count: hits.hits.length,
      newestAbsLine: hits.hits.length > 0 ? hits.hits[0].absLine : null,
      truncated: hits.truncated,
      skipped: null,
    };
  } catch {
    return none();
  }
}
