import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { SEARCH_HIGHLIGHT_LIMIT, type SearchOptions } from "./terminalSearch";
import { SEARCH_DECORATIONS } from "./terminalShared";

interface Context {
  readonly themeMode: "dark" | "light" | "serialx-dark" | "serialx-light";
}

export class TerminalSearchController {
  searchAddon = new SearchAddon({
    highlightLimit: SEARCH_HIGHLIGHT_LIMIT,
  });

  /** Fires after every search and whenever buffer changes shift the matches. */
  readonly onSearchResults = this.searchAddon.onDidChangeResults;

  private lastSearch: string | null = null;

  private lastSearchOptions: SearchOptions = {};

  /**
   * Find `query` in the buffer and highlight every match. `incremental`
   * keeps the current match selected while the query is still being typed,
   * instead of jumping to the next one.
   */
  search(query: string, forward = true, incremental = false, searchOptions: SearchOptions = {}) {
    if (!query) {
      this.clearSearch();
      return;
    }
    const optionsChanged =
      Boolean(this.lastSearchOptions.caseSensitive) !== Boolean(searchOptions.caseSensitive) ||
      Boolean(this.lastSearchOptions.wholeWord) !== Boolean(searchOptions.wholeWord) ||
      Boolean(this.lastSearchOptions.regex) !== Boolean(searchOptions.regex);
    if (optionsChanged) {
      // SearchAddon 0.16.0 assigns `_state.lastSearchOptions = searchOptions`
      // before `shouldUpdateHighlighting` compares them, so an option change
      // on the same term never re-highlights unless the cache is cleared first.
      this.searchAddon.clearDecorations();
    }
    this.lastSearch = query;
    this.lastSearchOptions = searchOptions;
    const options: ISearchOptions = {
      incremental,
      caseSensitive: searchOptions.caseSensitive,
      wholeWord: searchOptions.wholeWord,
      regex: searchOptions.regex,
      decorations: SEARCH_DECORATIONS[this.context.themeMode],
    };
    if (searchOptions.regex) {
      try {
        new RegExp(query, searchOptions.caseSensitive ? "g" : "gi");
      } catch {
        this.searchAddon.findNext("(?!)", { ...options, regex: true });
        this.searchAddon.clearDecorations();
        return;
      }
    }
    if (forward) this.searchAddon.findNext(query, options);
    else this.searchAddon.findPrevious(query, options);
  }

  /** Drop the match highlights; also stops re-searching on every write. */
  clearSearch() {
    this.lastSearch = null;
    this.lastSearchOptions = {};
    this.searchAddon.clearDecorations();
  }

  /**
   * Re-run the last search so highlights pick up the current theme colors.
   * The addon only re-highlights when the term or matching options change,
   * so the decorations are cleared first.
   */
  refreshSearch() {
    if (this.lastSearch === null) return;
    this.searchAddon.clearDecorations();
    if (this.lastSearchOptions.regex) {
      try {
        new RegExp(this.lastSearch, this.lastSearchOptions.caseSensitive ? "g" : "gi");
      } catch {
        return;
      }
    }
    this.searchAddon.findPrevious(this.lastSearch, {
      incremental: true,
      caseSensitive: this.lastSearchOptions.caseSensitive,
      wholeWord: this.lastSearchOptions.wholeWord,
      regex: this.lastSearchOptions.regex,
      decorations: SEARCH_DECORATIONS[this.context.themeMode],
    });
  }
  constructor(private readonly context: Context) {}
}
