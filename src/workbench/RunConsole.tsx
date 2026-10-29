import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import { useT } from "../useT";
import { transferBytes } from "../fileTransfers";
import { Icon } from "../components/icons";
import * as wb from "./api";
import { parseLogForJumps } from "./logJump";
import { formatClock, formatDuration, isRunLive, runCodeId, runStatusKey } from "./model";
import { connectedTabFor } from "./session";
import { useWorkbench } from "./store";
import type { RunRecord, RunStatus } from "./types";

export function RunConsole({
  run,
  onStop,
  onAttach,
  onResume,
}: {
  run: RunRecord | null;
  onStop: (id: string) => void;
  onAttach: (run: RunRecord) => void;
  onResume: (run: RunRecord) => void;
}) {
  const t = useT();
  const checkedAt = useWorkbench((state) => (run ? state.runCheckedAt[run.id] : undefined));
  const experiment = useWorkbench((state) =>
    run ? state.data.experiments.find((item) => item.id === run.experimentId) : undefined,
  );
  const runError = useWorkbench((state) => (run ? state.runErrors[run.id] : undefined));
  const reveal = useWorkbench((state) => state.setActiveRun);
  const openFile = useWorkbench((state) => state.openFile);
  const [log, setLog] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const offset = useRef(0);
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const session = run ? (connectedTabFor(run.server)?.info.id ?? null) : null;
  const live = run ? isRunLive(run.status) : false;
  // Only the interactive tail is parsed, and only when the log changed; a
  // 512 KiB view must not re-run the scan on every status tick.
  const parsed = useMemo(() => parseLogForJumps(log, run?.root ?? null), [log, run?.root]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setLog("");
    offset.current = 0;
    setLogError(null);
    follow.current = true;
  }, [run?.id]);

  // The tail restarts when the selected run, its log or its status changes;
  // appending to the existing offset keeps the read bounded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fields of run are the change signal
  useEffect(() => {
    if (!run || !session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const chunk = await wb.readLog(session, run.logPath, offset.current);
        if (stopped) return;
        offset.current = chunk.offset;
        setLog((previous) => {
          const next = chunk.reset ? chunk.content : `${previous}${chunk.content}`;
          // The view is a tail, not the whole log. Bounding it keeps a long
          // training run from growing the DOM without limit; the file on the
          // server keeps everything.
          const LIMIT = 512 * 1024;
          return next.length > LIMIT ? next.slice(next.length - LIMIT) : next;
        });
        setLogError(null);
      } catch (error) {
        if (!stopped) setLogError(errorText(error));
      }
      if (!stopped && isRunLive(run.status)) {
        timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [run?.id, run?.logPath, run?.status, session]);

  useEffect(() => {
    const element = pre.current;
    if (!element || !follow.current) return;
    element.scrollTop = element.scrollHeight;
  }, [log]);

  if (!run) {
    return (
      <section className="wb-console is-empty" aria-label={t("wb.runConsole")}>
        <div className="wb-console-head">
          <strong>{t("wb.runConsole")}</strong>
        </div>
        <p className="wb-console-note">{t("wb.noRuns")}</p>
      </section>
    );
  }

  // A live run whose server cannot be asked is unknown, not still running.
  // The record keeps its last status; only the presentation is downgraded.
  const effectiveStatus: RunStatus = runError ? "unknown" : run.status;
  const staleAfter = 30_000;
  const checked = checkedAt ?? run.lastSeenAt;
  const stale = live && checked > 0 && now - checked > staleAfter;
  const duration = formatDuration(run.startedAt, run.endedAt, now);
  return (
    <section
      className={`wb-console${collapsed ? " is-collapsed" : ""}`}
      aria-label={t("wb.runConsole")}
    >
      <div className="wb-console-head">
        <span className={`wb-status-pill is-${effectiveStatus}`}>
          <span className="wb-run-dot" />
          {t(runStatusKey(effectiveStatus))}
        </span>
        <strong>{experiment?.name ?? t("wb.experiment")}</strong>
        <code>{runCodeId(run)}</code>
        <span className="wb-console-time">{duration}</span>
        <span className={`wb-console-checked${stale || runError ? " is-stale" : ""}`}>
          {runError
            ? runError
            : checked
              ? t("wb.checkedAt", { time: formatClock(checked) })
              : t("wb.notChecked")}
        </span>
        <div className="wb-console-actions">
          <button
            type="button"
            className="wb-icon-button"
            aria-label={t(collapsed ? "wb.expandConsole" : "wb.collapseConsole")}
            title={t(collapsed ? "wb.expandConsole" : "wb.collapseConsole")}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
          </button>
          <button
            type="button"
            className="wb-icon-button"
            title={t("wb.openTerminal")}
            onClick={() => onAttach(run)}
          >
            <Icon name="terminal" />
          </button>
          <button type="button" className="btn wb-mini" onClick={() => onResume(run)}>
            {t("wb.resume")}
          </button>
          <button
            type="button"
            className="btn wb-mini is-danger"
            disabled={!live || !session}
            onClick={() => onStop(run.id)}
          >
            {t("wb.stop")}
          </button>
          <button
            type="button"
            className="wb-icon-button"
            title={t("wb.close")}
            onClick={() => reveal(null)}
          >
            ×
          </button>
        </div>
      </div>
      {stale && !collapsed && (
        <p className="wb-console-warning">{t("wb.staleStatus", { time: formatClock(checked) })}</p>
      )}
      <div className="wb-console-body" id={bodyId} hidden={collapsed}>
        <div className="wb-run-detail">
          <dl>
            <dt>{t("wb.server")}</dt>
            <dd>
              {run.server.name || run.server.host} · {run.server.username}@{run.server.host}:
              {run.server.port}
            </dd>
            <dt>{t("wb.runCommand")}</dt>
            <dd>
              <pre>{run.command}</pre>
            </dd>
            <dt>{t("wb.code")}</dt>
            <dd>
              {run.code.isRepository ? (
                <>
                  {run.code.branch || "detached"} @ {run.code.commit.slice(0, 10) || "—"}
                  {" · "}
                  {run.code.dirty
                    ? `${run.code.dirtyFiles.length} ${t("wb.dirty")}`
                    : t("wb.clean")}
                  {run.code.diffSha256 && (
                    <small title={run.code.diffSha256}>
                      {" · diff "}
                      {run.code.diffSha256.slice(0, 8)}
                    </small>
                  )}
                  {run.code.diffTruncated && <small> · {t("wb.diffTruncated")}</small>}
                </>
              ) : (
                t("wb.noRepo")
              )}
            </dd>
            {run.code.dirtyFiles.length > 0 && (
              <dd className="wb-dirty-files">
                <details>
                  <summary>
                    {t("wb.dirty")} ({run.code.dirtyFiles.length})
                  </summary>
                  <ul>
                    {run.code.dirtyFiles.slice(0, 50).map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </details>
              </dd>
            )}
            <dt>{t("wb.startedAt")}</dt>
            <dd>
              {formatClock(run.startedAt)}
              {run.endedAt ? ` → ${formatClock(run.endedAt)}` : ""}
            </dd>
            <dt>{t("wb.exitCode")}</dt>
            <dd>{run.exitCode ?? "—"}</dd>
            <dt>{t("wb.snapshot")}</dt>
            <dd>
              {run.snapshot.mode === "code"
                ? `${t("wb.snapshotSummary", {
                    files: run.snapshot.files,
                    size: transferBytes(run.snapshot.bytes),
                  })}${run.snapshot.skipped ? ` · ${t("wb.snapshotSkipped", { count: run.snapshot.skipped })}` : ""}`
                : t("wb.snapshotNone")}
            </dd>
            <dt>{t("wb.runBinding")}</dt>
            <dd>
              {run.binding.isolated ? t("wb.runIsolated") : t("wb.runWorkspace")}
              {` · ${
                run.binding.snapshotVerified
                  ? t("wb.runSnapshotVerified")
                  : run.snapshot.mode === "code"
                    ? t("wb.runSnapshotUnverified")
                    : t("wb.snapshotNone")
              }`}
            </dd>
            <dt>{t("wb.runExecutedFrom")}</dt>
            <dd className="wb-path-line" title={run.binding.executedFrom || run.root}>
              <span>{run.binding.executedFrom || run.root}</span>
            </dd>
            {run.binding.unsynced.length > 0 && (
              <>
                <dt>{t("wb.unsynced")}</dt>
                <dd className="wb-dirty-files">
                  <details>
                    <summary>{run.binding.unsynced.length}</summary>
                    <ul>
                      {run.binding.unsynced.slice(0, 50).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                  </details>
                </dd>
              </>
            )}
            {run.binding.isolated && (
              <>
                <dt>{t("wb.runLinks")}</dt>
                <dd>
                  {run.binding.links.length ? run.binding.links.join(" · ") : t("wb.runLinksNone")}
                </dd>
              </>
            )}
            <dt>{t("wb.runDir")}</dt>
            <dd className="wb-path-line" title={run.runDir}>
              <span>{run.runDir}</span>
              <button
                type="button"
                className="wb-icon-button"
                title={t("wb.copyPath")}
                onClick={() =>
                  void navigator.clipboard.writeText(run.runDir).catch(() => undefined)
                }
              >
                <Icon name="copy" />
              </button>
            </dd>
            <dt>{t("wb.logPath")}</dt>
            <dd className="wb-path-line" title={run.logPath}>
              <span>{run.logPath}</span>
              <button
                type="button"
                className="wb-icon-button"
                title={t("wb.copyPath")}
                onClick={() =>
                  void navigator.clipboard.writeText(run.logPath).catch(() => undefined)
                }
              >
                <Icon name="copy" />
              </button>
            </dd>
          </dl>
          {run.note && <p className="wb-console-note">{run.note}</p>}
          {run.scheduler && (
            <p className="wb-console-note">{t("wb.schedulerDetected", { name: run.scheduler })}</p>
          )}
          {run.mode !== "tmux" && <p className="wb-console-note">{t("wb.tmuxMissing")}</p>}
        </div>
        <div className="wb-log">
          <div className="wb-log-head">
            <span>{t("wb.runConsole")}</span>
            <span>{log ? transferBytes(log.length) : "0 B"}</span>
          </div>
          {!session && <p className="wb-console-warning">{t("wb.noSession")}</p>}
          {logError && <p className="wb-console-warning">{logError}</p>}
          <pre
            ref={pre}
            className="wb-log-view"
            onScroll={(event) => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
          >
            {log ? (
              <>
                {parsed.head}
                {parsed.lines.map((line, index) => {
                  const jump = line.jump;
                  // Without a live session the jump has nowhere to read from,
                  // so the line stays text instead of a dead button.
                  const node =
                    jump && session ? (
                      <button
                        type="button"
                        className="wb-log-link"
                        title={t("wb.logJumpOpen", { path: jump.path, line: jump.line })}
                        aria-label={t("wb.logJumpOpen", { path: jump.path, line: jump.line })}
                        onClick={() =>
                          void openFile(run.workspaceId, run.experimentId, jump.path, jump.line)
                        }
                      >
                        {line.text}
                      </button>
                    ) : (
                      line.text
                    );
                  return (
                    <Fragment key={index}>
                      {node}
                      {index < parsed.lines.length - 1 ? "\n" : null}
                    </Fragment>
                  );
                })}
              </>
            ) : live ? (
              t("wb.logWaiting")
            ) : (
              t("wb.logEmpty")
            )}
          </pre>
        </div>
      </div>
    </section>
  );
}
