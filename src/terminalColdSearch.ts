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
}

/**
 * Counts `needle` in a session's cold history for the find box (roadmap
 * A2-7). Plain, case-sensitive substring queries only: the store searches
 * literal needles, so regex, whole-word, and case-insensitive queries would
 * count against a different rule than the buffer search and mislead. A
 * disabled cold history or a failed request reports zero rather than
 * disturbing the box — the buffer search stands on its own.
 */
export async function searchColdHistory(
  sessionId: string,
  needle: string,
  options: { regex: boolean; wholeWord: boolean; caseSensitive: boolean },
  beforeAbsLine: number | null = null,
): Promise<ColdSearchOutcome> {
  const none: ColdSearchOutcome = { count: 0, newestAbsLine: null };
  if (!needle || options.regex || options.wholeWord || !options.caseSensitive) return none;
  if (!terminalColdHistoryEnabled()) return none;
  // The capture exports before xterm trims: some archived records are still
  // searchable in the hot buffer. Only lines strictly older than its first
  // archived logical line are cold-only. An unknown boundary is not a count.
  if (!Number.isSafeInteger(beforeAbsLine) || beforeAbsLine === null || beforeAbsLine <= 1) {
    return none;
  }
  try {
    // Filter before the Rust hit limit, not after receiving 200 newest hits:
    // otherwise a full page of hot-overlap matches can hide older matches.
    const hits = await commands.historySearchBefore(
      sessionId,
      needle,
      COLD_SEARCH_LIMIT,
      COLD_SEARCH_BUDGET_MS,
      beforeAbsLine,
    );
    return { count: hits.length, newestAbsLine: hits.length > 0 ? hits[0].absLine : null };
  } catch {
    return none;
  }
}
