import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { errorText } from "../errorInfo";
import { classifyLogFollow, logMatches, MAX_LOG_MATCHES } from "../logViewer";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

const FOLLOW_INTERVAL_MS = 3000;

export interface LogViewerTarget {
  sessionId: string | null;
  path: string;
  name: string;
  sourceTabId: string;
}

/** No file content survives a viewer close; only one bounded window is held. */
export function LogViewerDialog({
  target,
  onClose,
}: {
  target: LogViewerTarget;
  onClose: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<api.LogWindow | null>(null);
  const pageRef = useRef<api.LogWindow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [encodingMode, setEncodingMode] = useState("auto");
  const encodingModeRef = useRef("auto");
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const highlightRef = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);

  const updatePage = useCallback((next: api.LogWindow) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const load = useCallback(
    async (
      anchor: number | null,
      before: boolean,
      followAfter = false,
      encodingOverride?: string | null,
    ) => {
      const current = ++requestId.current;
      setBusy(true);
      setError(null);
      try {
        const encoding =
          encodingOverride !== undefined
            ? encodingOverride
            : encodingModeRef.current === "auto"
              ? (pageRef.current?.encoding ?? null)
              : encodingModeRef.current;
        const next = await api.readLogWindow(
          target.sessionId,
          target.path,
          anchor,
          before,
          encoding,
        );
        if (requestId.current !== current) return;
        updatePage(next);
        setNotice(null);
        if (followAfter) setFollowing(true);
      } catch (cause) {
        if (requestId.current !== current) return;
        setFollowing(false);
        setError(errorText(cause));
      } finally {
        if (requestId.current === current) setBusy(false);
      }
    },
    [target.sessionId, target.path, updatePage],
  );

  useEffect(() => {
    void load(null, true);
    return () => {
      // Closing, switching tabs and changing files invalidate every in-flight read.
      requestId.current += 1;
      pageRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!following) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (!disposed) timer = setTimeout(() => void tick(), FOLLOW_INTERVAL_MS);
    };
    const tick = async () => {
      if (disposed) return;
      if (document.hidden) {
        schedule();
        return;
      }
      const previous = pageRef.current;
      if (!previous) {
        schedule();
        return;
      }
      const current = requestId.current;
      try {
        // Poll at the last byte seen. An unchanged file only costs SFTP stat;
        // no full-window transfer and no periodic polling when follow is off.
        const next = await api.readLogWindow(
          target.sessionId,
          target.path,
          previous.end,
          false,
          previous.encoding,
        );
        if (disposed || requestId.current !== current) return;
        const decision = classifyLogFollow(previous, next);
        if (decision === "rotated") {
          const latest = await api.readLogWindow(
            target.sessionId,
            target.path,
            null,
            true,
            encodingModeRef.current === "auto" ? null : encodingModeRef.current,
          );
          if (disposed || requestId.current !== current) return;
          updatePage(latest);
          setNotice(t("logViewer.rotated"));
        } else if (decision === "append" || decision === "reload") {
          // At most 256 KiB of text stays in React, even if a log grows for days.
          if (decision === "reload") {
            const latest = await api.readLogWindow(
              target.sessionId,
              target.path,
              null,
              true,
              previous.encoding,
            );
            if (disposed || requestId.current !== current) return;
            updatePage(latest);
          } else {
            updatePage({
              ...next,
              start: previous.start,
              content: previous.content + next.content,
            });
          }
        } else if (decision === "replaced") {
          // Same-size replacement/rotation can happen without any append.
          const latest = await api.readLogWindow(
            target.sessionId,
            target.path,
            null,
            true,
            encodingModeRef.current === "auto" ? null : encodingModeRef.current,
          );
          if (disposed || requestId.current !== current) return;
          updatePage(latest);
          setNotice(t("logViewer.replaced"));
        }
      } catch (cause) {
        if (disposed || requestId.current !== current) return;
        setFollowing(false);
        setError(errorText(cause));
        return;
      }
      schedule();
    };
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [following, target.path, target.sessionId, t, updatePage]);

  const matches = useMemo(() => logMatches(page?.content ?? "", query), [page?.content, query]);
  useEffect(() => setMatchIndex(0), [page?.content, query]);
  useEffect(() => {
    if (matches.length) highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [matchIndex, matches]);

  const highlight = matches[matchIndex];
  const body = page?.content ?? "";
  const find = query.length > 0 && highlight !== undefined;
  const leaveFollow = () => setFollowing(false);
  const jump = (anchor: number | null, before: boolean) => {
    leaveFollow();
    void load(anchor, before);
  };

  return (
    <ModalDialog
      open
      onClose={onClose}
      dismissable={false}
      title={t("logViewer.title")}
      contentClassName="log-viewer-dialog"
      initialFocus=".log-viewer-search"
    >
      <div className="log-viewer-location">
        <strong title={target.name}>{target.name}</strong>
        <code title={target.path}>{target.path}</code>
        <small>{t("logViewer.readOnlyHint")}</small>
      </div>
      <div className="log-viewer-toolbar">
        <div className="log-viewer-search-group">
          <input
            className="log-viewer-search"
            type="search"
            value={query}
            maxLength={256}
            placeholder={t("logViewer.searchWindow")}
            aria-label={t("logViewer.searchWindow")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <span className="log-viewer-match-count" role="status">
            {query
              ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}${matches.length === MAX_LOG_MATCHES ? "+" : ""}`
              : ""}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!matches.length}
            aria-label={t("logViewer.previousMatch")}
            title={t("logViewer.previousMatch")}
            onClick={() => setMatchIndex((index) => (index + matches.length - 1) % matches.length)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn"
            disabled={!matches.length}
            aria-label={t("logViewer.nextMatch")}
            title={t("logViewer.nextMatch")}
            onClick={() => setMatchIndex((index) => (index + 1) % matches.length)}
          >
            ↓
          </button>
        </div>
        <label className="log-viewer-encoding">
          <span>{t("logViewer.encoding")}</span>
          <select
            value={encodingMode}
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              encodingModeRef.current = value;
              setEncodingMode(value);
              leaveFollow();
              void load(pageRef.current?.end ?? null, true, false, value === "auto" ? null : value);
            }}
          >
            <option value="auto">{t("logViewer.autoEncoding")}</option>
            <option value="UTF-8">UTF-8</option>
            <option value="GBK">GBK</option>
            <option value="GB18030">GB18030</option>
            <option value="Big5">Big5</option>
          </select>
        </label>
      </div>
      <div className="log-viewer-content" role="region" aria-label={t("logViewer.content")}>
        {!page && busy ? (
          <p className="file-editor-empty">{t("common.loading")}</p>
        ) : !page ? (
          <p className="file-editor-empty">{t("logViewer.noContent")}</p>
        ) : (
          <pre className="log-viewer-text" tabIndex={0}>
            {find ? (
              <>
                {body.slice(0, highlight)}
                <mark ref={highlightRef}>{body.slice(highlight, highlight + query.length)}</mark>
                {body.slice(highlight + query.length)}
              </>
            ) : (
              body || t("logViewer.empty")
            )}
          </pre>
        )}
      </div>
      {notice && (
        <div className="log-viewer-notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="dialog-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer log-viewer-footer">
        <span className="log-viewer-range" role="status">
          {page
            ? `${page.start.toLocaleString()}–${page.end.toLocaleString()} / ${page.size.toLocaleString()} B · ${page.encoding}`
            : t("common.loading")}
        </span>
        <button
          type="button"
          className="btn"
          disabled={!page || busy || page.start === 0}
          onClick={() => jump(page?.start ?? null, true)}
        >
          {t("logViewer.previousWindow")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!page || busy || page.end >= page.size}
          onClick={() => jump(page?.end ?? null, false)}
        >
          {t("logViewer.nextWindow")}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => jump(null, true)}>
          {t("logViewer.latest")}
        </button>
        <button
          type="button"
          className={`btn${following ? " is-primary" : ""}`}
          disabled={busy}
          aria-pressed={following}
          onClick={() => {
            if (following) leaveFollow();
            else void load(null, true, true);
          }}
        >
          {following ? t("logViewer.stopFollow") : t("logViewer.follow")}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
