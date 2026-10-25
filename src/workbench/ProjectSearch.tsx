import { useEffect, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import { useT } from "../useT";
import * as wb from "./api";
import type { SearchResult } from "./types";

export function ProjectSearch({
  sessionId,
  root,
  onOpen,
  onClose,
}: {
  sessionId: string | null;
  root: string;
  onOpen: (path: string, line: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    input.current?.focus();
    pending.current = false;
    setBusy(false);
    setResult(null);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [sessionId, root]);

  const run = async () => {
    if (!sessionId || !query.trim() || pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const found = await wb.search(sessionId, root, query.trim());
      if (generation.current === request) setResult(found);
    } catch (failure) {
      if (generation.current === request) {
        setResult(null);
        setError(errorText(failure));
      }
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div className="wb-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="wb-search"
        role="dialog"
        aria-modal="true"
        aria-label={t("wb.search")}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="wb-search-bar">
          <input
            ref={input}
            value={query}
            placeholder={t("wb.searchPlaceholder")}
            aria-label={t("wb.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void run();
            }}
          />
          <button
            type="button"
            className="btn is-primary"
            disabled={!sessionId || busy}
            onClick={() => void run()}
          >
            {busy ? t("wb.searching") : t("wb.search")}
          </button>
        </div>
        {!sessionId && <p className="wb-search-note">{t("wb.noSession")}</p>}
        {error && <p className="wb-search-error">{error}</p>}
        {result && (
          <>
            <p className="wb-search-note">
              {result.matches.length === 0
                ? t("wb.searchEmpty")
                : `${result.matches.length} · ${result.skipped}`}
              {result.truncated ? ` · ${t("wb.searchTruncated")}` : ""}
            </p>
            <div className="wb-search-results" role="listbox">
              {result.matches.map((match) => (
                <button
                  type="button"
                  key={`${match.path}:${match.line}:${match.text}`}
                  className="wb-search-row"
                  title={`${match.path}:${match.line}`}
                  onClick={() => {
                    onOpen(match.path, match.line);
                    onClose();
                  }}
                >
                  <span className="wb-search-path">
                    {match.path}
                    <small>{t("wb.line", { line: match.line })}</small>
                  </span>
                  <code>{match.text.trim()}</code>
                </button>
              ))}
            </div>
          </>
        )}
        {!result && !error && <p className="wb-search-note">{t("wb.searchScope")}</p>}
      </div>
    </div>
  );
}
