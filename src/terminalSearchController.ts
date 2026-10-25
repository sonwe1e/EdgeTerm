import type { IDisposable, Terminal } from "@xterm/xterm";

import { TerminalFind } from "./terminalFind";
import { DEFAULT_FIND_OPTIONS, type FindOptions, type SearchResults } from "./terminalSearch";
import { FIND_COLORS } from "./terminalShared";
import type { ThemeMode } from "./types";

interface Context {
  readonly term: Terminal;
  readonly themeMode: ThemeMode;
}

/**
 * The find engine behind a terminal's search box (issue #95). It wraps
 * TerminalFind where it used to wrap xterm's search addon: the box passes
 * FindOptions and reads the match count through `onSearchResults`, the
 * current match stays the terminal selection, and the highlight colors
 * follow the terminal's theme.
 */
export class TerminalSearchController {
  private readonly finder: TerminalFind;

  /**
   * Find `query` in the buffer and highlight every match. `incremental`
   * keeps the current match selected while the query is still being typed,
   * instead of jumping to the next one.
   */
  search(
    query: string,
    forward = true,
    incremental = false,
    options: FindOptions = DEFAULT_FIND_OPTIONS,
  ) {
    this.finder.find(query, options, forward, incremental);
  }

  /** Fires after every search and when output has moved the matches. */
  onSearchResults(listener: (results: SearchResults) => void): IDisposable {
    return this.finder.onResults(listener);
  }

  /**
   * Find in Selection: search only the current selection (or, when a search
   * has since moved the selection to a match, the one the user made). False
   * when there is no selection to search in.
   */
  setSearchScope(on: boolean): boolean {
    return this.finder.setScope(on);
  }

  /**
   * Drop the match highlights and the range. The selection, which is the
   * last match found, stays.
   */
  clearSearch() {
    this.finder.clear();
  }

  /** Re-paint the highlights in the current theme's colors. */
  refreshSearch() {
    this.finder.setColors(FIND_COLORS[this.context.themeMode]);
  }

  /** The buffer changed without a write (cleared, trimmed): re-read it. */
  bufferChanged() {
    this.finder.bufferChanged();
  }

  dispose() {
    this.finder.dispose();
  }

  constructor(private readonly context: Context) {
    this.finder = new TerminalFind(context.term, FIND_COLORS[context.themeMode]);
  }
}
