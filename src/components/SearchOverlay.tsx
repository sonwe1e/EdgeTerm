import { useStableCallback } from "../useStableCallback";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";

import { matchAppShortcut } from "../shortcuts";
import { useActiveTab, useStore } from "../store";
import {
  SEARCH_HIGHLIGHT_LIMIT,
  type SearchOptions,
  type SearchResults,
} from "../terminalSearch";
import { getController } from "../terminalRegistry";
import { isFileSession } from "../types";
import { t as translateMsg } from "../i18n";
import { useT } from "../useT";
import { Icon } from "./icons";

interface Props {
  onClose: () => void;
}

export interface SearchOverlayHandle {
  /** Jump to the next match, or focus the input when there is no query yet. */
  findNext: () => void;
  /**
   * Focus the input and select the query so typing replaces it. A new
   * single-line terminal selection is searched instead, as when the box opens.
   */
  focus: () => void;
}

// Find / Find Next while typing in the box: ⌘F / ⌘G on macOS,
// Ctrl+Shift+F / Ctrl+Shift+G elsewhere. The window-level shortcut handler
// ignores key events from inputs, so the shortcuts are mirrored here.
const isFindKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "find";
const isFindNextKey = (event: KeyboardEvent) =>
  matchAppShortcut(event)?.kind === "findNext";

/**
 * The terminal's current selection, which opening the box (or pressing ⌘F
 * again) searches for. Multi-line selections cannot match, so they yield "".
 */
const selectedText = (sessionId: string | null) => {
  if (!sessionId) return "";
  const text = getController(sessionId)?.term.getSelection() ?? "";
  return text.includes("\n") ? "" : text;
};

/** "3/12", "1000+" past the highlight limit, or "No results". */
const formatResults = ({ resultIndex, resultCount }: SearchResults) => {
  if (resultCount === 0) return translateMsg("search.noResults");
  const total =
    resultCount >= SEARCH_HIGHLIGHT_LIMIT
      ? `${SEARCH_HIGHLIGHT_LIMIT}+`
      : String(resultCount);
  return resultIndex >= 0 ? `${resultIndex + 1}/${total}` : total;
};

/**
 * The find box above the terminal. It is mounted only while open, so every
 * opening starts from the terminal selection (or empty) rather than from
 * the previous query.
 */
export const SearchOverlay = forwardRef<SearchOverlayHandle, Props>(
  function SearchOverlay({ onClose }, ref) {
    const tab = useActiveTab();
    const activeId = useStore((s) => s.activeId);
    const t = useT();
    const [query, setQuery] = useState(() => selectedText(activeId));
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [results, setResults] = useState<SearchResults | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // The session whose buffer currently carries match highlights, so they
    // can be dropped when the search moves elsewhere or ends.
    const searchedRef = useRef<string | null>(null);

    // Select the previous query on focus so a new search (typed or pasted)
    // replaces it instead of being appended to it. A query taken from the
    // terminal selection is already being searched, so the caret just sits
    // after it.
    const focusInput = useStableCallback((selectQuery = true) => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (selectQuery) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    });

    const clearSearch = useStableCallback(() => {
      if (searchedRef.current) getController(searchedRef.current)?.clearSearch();
      searchedRef.current = null;
      setResults(null);
    });

    const runSearch = useStableCallback(
      (
        forward: boolean,
        incremental: boolean = false,
        term: string = query,
        options: SearchOptions = { caseSensitive, wholeWord, regex },
      ) => {
        if (!activeId) return;
        if (!term) {
          clearSearch();
          return;
        }
        if (searchedRef.current !== activeId) clearSearch();
        searchedRef.current = activeId;
        getController(activeId)?.search(term, forward, incremental, options);
      },
    );

    const toggleOption = useStableCallback((next: SearchOptions) => {
      const merged: SearchOptions = {
        caseSensitive,
        wholeWord,
        regex,
        ...next,
      };
      if (next.caseSensitive !== undefined) setCaseSensitive(next.caseSensitive);
      if (next.wholeWord !== undefined) setWholeWord(next.wholeWord);
      if (next.regex !== undefined) setRegex(next.regex);
      if (query) runSearch(true, true, query, merged);
    });

    // Highlights and the counter belong to one session; switching tabs ends
    // that search rather than showing stale numbers.
    useEffect(() => {
      if (searchedRef.current && searchedRef.current !== activeId) clearSearch();
    }, [activeId]);

    // Subscribed before the initial search below so its count is not missed:
    // the addon reports results synchronously.
    useEffect(() => {
      if (!activeId) return;
      const listener = getController(activeId)?.onSearchResults(setResults);
      return () => listener?.dispose();
    }, [activeId]);

    // Search the seeded selection right away; the search starts at the
    // selection, so it stays the current match. Closing the box drops the
    // highlights.
    const [seededQuery] = useState(query);
    useEffect(() => {
      if (seededQuery) runSearch(true, true, seededQuery);
      return clearSearch;
    }, [seededQuery, runSearch, clearSearch]);

    // The tab the box opened in. Its seeded query is left unselected there;
    // after a tab switch the query is selected so typing replaces it. (Kept
    // as state, not a mutable ref, so StrictMode's repeated effects agree.)
    const [openedIn] = useState({ tab: tab?.info.id, seeded: query !== "" });
    const tabId = tab?.info.id, tabKind = tab?.info.kind;
    useEffect(() => {
      if (tabKind && isFileSession(tabKind)) return;
      focusInput(!(openedIn.seeded && tabId === openedIn.tab));
    }, [tabId, tabKind, openedIn, focusInput]);

    // Adopt a fresh terminal selection as the query and search it. The input
    // is updated synchronously so the focus that follows sees the new text.
    const adoptSelection = useStableCallback(() => {
      const term = selectedText(activeId);
      if (!term || term === query) return false;
      flushSync(() => setQuery(term));
      runSearch(true, true, term);
      return true;
    });

    useImperativeHandle(
      ref,
      () => ({
        findNext: () => {
          if (query) runSearch(true);
          else focusInput();
        },
        focus: () => {
          const adopted = adoptSelection();
          focusInput(!adopted);
        },
      }),
      [activeId, query],
    );

    if (!tab || isFileSession(tab.info.kind)) return null;

    return (
      <div className="terminal-search" role="search">
        <input
          ref={inputRef}
          value={query}
          placeholder={t("search.placeholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            const term = event.target.value;
            setQuery(term);
            // Search as the query is typed so the counter always matches it.
            runSearch(true, true, term);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch(!event.shiftKey);
            else if (event.key === "Escape") onClose();
            else if (isFindKey(event)) {
              // ⌘F inside the box re-selects the query, like ⌘F elsewhere.
              event.preventDefault();
              event.currentTarget.select();
            } else if (isFindNextKey(event)) {
              event.preventDefault();
              runSearch(true);
            }
          }}
        />
        <button
          type="button"
          className={`panel-action search-option${caseSensitive ? " is-active" : ""}`}
          aria-pressed={caseSensitive}
          onClick={() => toggleOption({ caseSensitive: !caseSensitive })}
          title={t("search.matchCase")}
          aria-label={t("search.matchCase")}
        >
          <Icon name="case-sensitive" />
        </button>
        <button
          type="button"
          className={`panel-action search-option${wholeWord ? " is-active" : ""}`}
          aria-pressed={wholeWord}
          onClick={() => toggleOption({ wholeWord: !wholeWord })}
          title={t("search.wholeWord")}
          aria-label={t("search.wholeWord")}
        >
          <Icon name="whole-word" />
        </button>
        <button
          type="button"
          className={`panel-action search-option${regex ? " is-active" : ""}`}
          aria-pressed={regex}
          onClick={() => toggleOption({ regex: !regex })}
          title={t("search.regex")}
          aria-label={t("search.regex")}
        >
          <Icon name="regex" />
        </button>
        <span
          className={`search-count${
            results?.resultCount === 0 ? " is-empty" : ""
          }`}
          aria-live="polite"
        >
          {results ? formatResults(results) : ""}
        </span>
        <button
          className="panel-action"
          onClick={() => runSearch(false)}
          title={t("search.previous")}
          aria-label={t("search.previous")}
        >
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action"
          onClick={() => runSearch(true)}
          title={t("search.next")}
          aria-label={t("search.next")}
        >
          <Icon name="arrow-down" />
        </button>
        <button
          className="panel-action"
          onClick={onClose}
          title={t("search.close")}
          aria-label={t("search.close")}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  },
);
