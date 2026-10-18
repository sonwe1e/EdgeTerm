import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../useT";
import { fuzzyFilter } from "./model";
import type { FileList } from "./types";

export function QuickOpen({
  files,
  onOpen,
  onClose,
}: {
  files: FileList | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => (files ? fuzzyFilter(query, files.files, 200) : []),
    [files, query],
  );

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (path: string) => {
    onOpen(path);
    onClose();
  };

  return (
    <div className="wb-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="wb-quickopen"
        role="dialog"
        aria-modal="true"
        aria-label={t("wb.quickOpen")}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(results.length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter" && results[active]) {
            event.preventDefault();
            choose(results[active]);
          }
        }}
      >
        <input
          ref={input}
          value={query}
          placeholder={t("wb.quickOpenPlaceholder")}
          aria-label={t("wb.quickOpen")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="wb-quickopen-results" role="listbox">
          {results.length === 0 && (
            <p className="wb-quickopen-empty">
              {files ? t("wb.searchEmpty") : t("wb.loading")}
            </p>
          )}
          {results.map((path, index) => (
            <button
              type="button"
              key={path}
              role="option"
              aria-selected={index === active}
              className={`wb-quickopen-row${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(path)}
            >
              <span>{path.split("/").pop()}</span>
              <small>{path}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
