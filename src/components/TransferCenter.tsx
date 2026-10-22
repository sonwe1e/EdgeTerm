import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import {
  startTransferSubscription,
  transferActive,
  transferBytes,
  useFileTransfers,
  type TransferView,
} from "../fileTransfers";
import { Icon } from "./icons";
import { readTransferOptions, saveTransferOptions, validRateLimitBps } from "../transferSettings";
import { useStore } from "../store";
import { VirtualFileRows } from "./VirtualFileRows";
import { StatusPopover } from "./StatusPopover";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";
import type { MessageKey } from "../i18n";

/**
 * Every queue row is exactly this tall, so VirtualFileRows can place a
 * windowed row without measuring it: status pill and name, progress, then one
 * metadata line. Three lines at a fixed pitch is what makes a long queue read
 * as rows instead of cards.
 */
const JOB_ROW_HEIGHT = 76;
/** A recovery row carries a name line and one metadata line; no progress. */
const RECOVERY_ROW_HEIGHT = 56;
/** One failed file per line, ellipsised. */
const FAILURE_ROW_HEIGHT = 24;

/** KiB/s the user typed, or 0 for unlimited; the backend stores bytes per second. */
function rateKib(options: api.TransferOptions): number {
  return Math.round(options.rateLimitBps / 1024);
}

/** The wire status is a stable token; the popover shows a phrase. */
const STATUS_LABEL: Record<string, MessageKey> = {
  queued: "transfer.statusQueued",
  running: "transfer.statusRunning",
  retrying: "transfer.statusRetrying",
  paused: "transfer.statusPaused",
  complete: "transfer.statusComplete",
  error: "transfer.statusError",
  cancelled: "transfer.statusCancelled",
  cancelling: "transfer.statusCancelling",
  dismissed: "transfer.dismissed",
};

/** Tones the pill's ink and tint; every tone is a theme token, not a colour. */
const STATUS_TONE: Record<string, string> = {
  queued: "idle",
  running: "active",
  retrying: "active",
  pausing: "active",
  cancelling: "active",
  paused: "paused",
  complete: "done",
  error: "failed",
  cancelled: "idle",
  dismissed: "idle",
};

/**
 * The in-row confirmation for clearing a failed record. It owns its focus:
 * the button that opened it is replaced by this band, so a keyboard user
 * would otherwise land on the document. Cancelling hands focus back to the
 * row that asked.
 */
function ClearFailedConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirm.current?.focus(); }, []);
  return (
    <article className="transfer-job is-confirming" role="group" aria-label={t("transfer.clearFailedQuestion")}>
      <div className="transfer-job-head">
        <strong className="transfer-confirm-question">{t("transfer.clearFailedQuestion")}</strong>
        <div className="transfer-job-actions">
          <button ref={confirm} type="button" onClick={onConfirm}>{t("transfer.dismiss")}</button>
          <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      </div>
      <p className="transfer-confirm-hint">{t("transfer.clearFailedHint")}</p>
    </article>
  );
}

export function TransferCenter() {
  const t = useT();
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL[status];
    return key ? t(key) : status;
  };
  const records = useFileTransfers((s) => s.jobs);
  const open = useFileTransfers((s) => s.open);
  const setOpen = useFileTransfers((s) => s.setOpen);
  const container = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), container);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(readTransferOptions);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setOptions(readTransferOptions()), [preferencesRevision]);
  const [recoverable, setRecoverable] = useState<api.RecoverableTransfer[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [failureJob, setFailureJob] = useState<string | null>(null);
  /** The failed record waiting for its explicit confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The bulk "clear failed" awaiting confirmation. */
  const [bulkClear, setBulkClear] = useState(false);
  const recoveryRows = useMemo(() => recoverable.map((entry) => ({ ...entry, path: entry.id })), [recoverable]);
  const failures = failureJob ? records[failureJob]?.failedFiles : undefined;
  const failureRows = useMemo(() => (failures ?? []).map((message, index) => ({ path: String(index), message })), [failures]);
  const alive = useRef(true);
  // Only the newest list request may render: an older response arriving
  // late would re-show an entry the user already resumed or forgot.
  const recoveryRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++recoveryRequest.current; };
  }, []);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void startTransferSubscription().then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch((e) => { if (!disposed) setError(errorText(e)); });
    return () => { disposed = true; stop?.(); };
  }, []);
  const refreshRecoverable = useCallback(() => {
    const request = ++recoveryRequest.current;
    api.listRecoverableTransfers()
      .then((found) => {
        if (alive.current && recoveryRequest.current === request) {
          setRecoverable(found);
          setRecoveryError(null);
        }
      })
      .catch((e) => { if (alive.current && recoveryRequest.current === request) setRecoveryError(errorText(e)); });
  }, []);
  // Once on mount: an interrupted transfer waiting to be resumed is worth
  // naming on the status bar, not only inside the popover the user has to
  // open first. `refreshRecoverable` never changes identity, so this is the
  // one startup discovery.
  useEffect(() => {
    refreshRecoverable();
  }, [refreshRecoverable]);
  useEffect(() => {
    if (open) refreshRecoverable();
  }, [open, refreshRecoverable]);
  const recover = async (id: string) => {
    setRecoveryError(null);
    try {
      // Progress ticks ride the channel; full snapshots arrive through the
      // transfer:changed subscription like any other job.
      await api.recoverTransfer(id, () => {});
      if (alive.current) refreshRecoverable();
    } catch (e) { if (alive.current) setRecoveryError(errorText(e)); }
  };
  const forget = async (id: string) => {
    setRecoveryError(null);
    try {
      await api.discardRecoverableTransfer(id);
      if (!alive.current) return;
      ++recoveryRequest.current;
      setRecoverable((found) => found.filter((entry) => entry.id !== id));
    } catch (e) { if (alive.current) setRecoveryError(errorText(e)); }
  };
  const jobs = useMemo(() => Object.values(records).sort((a, b) => b.id.localeCompare(a.id)), [records]);
  const jobRows = useMemo(() => jobs.map((job) => ({ ...job, path: job.id })), [jobs]);
  const active = jobs.filter((j) => transferActive(j.status)).length;
  const failedJobs = useMemo(() => jobs.filter((job) => job.status === "error"), [jobs]);
  // Only a job this app finished cleanly can be cleared without a question:
  // a cancelled job that failed during cleanup still owns remote partials.
  const finishedJobs = useMemo(
    () => jobs.filter((job) => job.status === "complete" || (job.status === "cancelled" && !job.error)),
    [jobs],
  );
  // One line for the whole queue: the rows below carry the per-job detail,
  // and a queue of five files used to ask the reader to add up five bars.
  const queueTotals = useMemo(() => {
    let done = 0;
    let total = 0;
    let transferred = 0;
    let bytes = 0;
    let rate = 0;
    let remaining = 0;
    for (const job of jobs) {
      done += job.completedFiles;
      total += job.totalFiles;
      transferred += job.transferred;
      bytes += job.total;
      if (job.status === "running") rate += job.bytesPerSecond;
      // Only work that will still move counts toward the estimate: a paused
      // or finished job's remainder would never arrive.
      if (transferActive(job.status)) remaining += Math.max(0, job.total - job.transferred);
    }
    return { done, total, transferred, bytes, rate, remaining };
  }, [jobs]);
  const queueEta = queueTotals.rate > 0 && queueTotals.remaining > 0
    ? Math.ceil(queueTotals.remaining / queueTotals.rate)
    : null;
  const totalsText = [
    t("transfer.filesCount", { done: queueTotals.done, total: queueTotals.total }),
    `${transferBytes(queueTotals.transferred)} / ${transferBytes(queueTotals.bytes)}`,
    queueTotals.rate > 0 ? `${transferBytes(queueTotals.rate)}/s` : "",
    queueEta !== null ? t("transfer.etaRemaining", { seconds: queueEta }) : "",
  ].filter(Boolean).join(" · ");
  // What the status bar item says. Running work counts first, then failures;
  // an interrupted transfer waiting to be resumed names itself, because the
  // popover that would tell the user is closed until asked for.
  const statusCount = active > 0
    ? ` (${active})`
    : failedJobs.length > 0
      ? t("transfer.failedCountParen", { count: failedJobs.length })
      : recoverable.length > 0
        ? ` (${recoverable.length})`
        : "";
  const statusName = active > 0 || failedJobs.length > 0 || recoverable.length === 0
    ? t("transfer.transfers")
    : t("transfer.interrupted");
  const statusTitle = [
    t("transfer.backgroundTitle"),
    active > 0 ? ` (${active})` : "",
    failedJobs.length > 0 ? t("transfer.failedCountParen", { count: failedJobs.length }) : "",
    recoverable.length > 0 ? ` · ${t("transfer.interrupted")} (${recoverable.length})` : "",
  ].join("");
  /**
   * The row or the bulk band that held focus is gone once a clear lands, so
   * focus moves to the next failed record, then to the header actions, and
   * only then to the close control. Keyboard users never fall back to the
   * document.
   */
  const focusAfterClear = () => {
    requestAnimationFrame(() => {
      const next = container.current?.querySelector<HTMLButtonElement>("[data-clear-failed]")
        ?? container.current?.querySelector<HTMLButtonElement>(".transfer-head-action")
        ?? container.current?.querySelector<HTMLButtonElement>(".status-popover-close");
      next?.focus();
    });
  };
  const control = async (id: string, action: Parameters<typeof api.controlFileTransfer>[1]) => {
    setError(null);
    // Any control on this job ends a pending clear question: the status it
    // was asked for is about to change.
    setConfirming((current) => current === id ? null : current);
    try {
      await api.controlFileTransfer(id, action);
      if (action === "dismiss") {
        useFileTransfers.getState().remove(id);
        setFailureJob((current) => current === id ? null : current);
        focusAfterClear();
      }
    } catch (e) { setError(errorText(e)); }
  };
  /**
   * Clearing a record is local bookkeeping: the row and the backend's journal
   * go, and nothing on the server is touched. A transfer that failed in
   * flight may leave partial files on the server, so this path is only
   * reachable after the explicit in-row confirmation; active jobs never
   * offer it (and the backend refuses them too).
   */
  const clearFailed = async (id: string) => {
    setConfirming(null);
    await control(id, "dismiss");
  };
  const cancelConfirm = (id: string) => {
    setConfirming(null);
    // The Clear button that opened the band returns with the row.
    requestAnimationFrame(() => {
      container.current?.querySelector<HTMLButtonElement>(`[data-clear-failed="${id}"]`)?.focus();
    });
  };
  /**
   * Bulk clear over the jobs that are safe to clear: results are independent,
   * so one refusal (the job restarted, say) keeps the others going and every
   * failure is reported instead of silently dropping the rest.
   */
  const clearJobs = async (ids: string[]) => {
    setBulkClear(false);
    setError(null);
    const problems: string[] = [];
    for (const id of ids) {
      try {
        await api.controlFileTransfer(id, "dismiss");
        useFileTransfers.getState().remove(id);
      } catch (e) { problems.push(errorText(e)); }
    }
    if (problems.length > 0) setError(problems.join(" · "));
    setFailureJob((current) => current && ids.includes(current) ? null : current);
    focusAfterClear();
  };
  const headerActions = failedJobs.length > 0 || finishedJobs.length > 0 ? <>
    {failedJobs.length > 0 && <button
      type="button"
      className="transfer-head-action"
      onClick={() => { setBulkClear(true); setConfirming(null); }}
    >{t("transfer.clearFailed")}</button>}
    {finishedJobs.length > 0 && <button
      type="button"
      className="transfer-head-action"
      onClick={() => void clearJobs(finishedJobs.map((job) => job.id))}
    >{t("transfer.clearFinished")}</button>}
  </> : undefined;
  const jobMeta = (job: TransferView) => {
    // A failure's own message is the one line worth showing; progress numbers
    // on a stopped job explain nothing.
    if (job.error) return job.error.message;
    const parts = [
      t("transfer.filesCount", { done: job.completedFiles, total: job.totalFiles }),
      `${transferBytes(job.transferred)} / ${transferBytes(job.total)}`,
    ];
    if (job.status === "running") {
      if (job.bytesPerSecond > 0) parts.push(`${transferBytes(job.bytesPerSecond)}/s`);
      const eta = job.total > job.transferred && job.bytesPerSecond > 0
        ? Math.ceil((job.total - job.transferred) / job.bytesPerSecond)
        : null;
      if (eta !== null) parts.push(t("transfer.etaRemaining", { seconds: eta }));
      if (job.options.rateLimitBps > 0) parts.push(t("transfer.rateLimit", { value: transferBytes(job.options.rateLimitBps) }));
    }
    return parts.join(" · ");
  };
  return <div className="transfer-center" ref={container}>
    <button
      className={`status-item${failedJobs.length > 0 ? " is-error" : ""}`}
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      title={statusTitle}
    >
      <Icon name="cloud-download" /> {statusName}{statusCount}
    </button>
    {open && <StatusPopover
      className="transfer-center-popover"
      label={t("transfer.transfers")}
      title={t("transfer.transfers")}
      closeLabel={t("transfer.closeTransfers")}
      onClose={() => setOpen(false)}
      actions={headerActions}
    >
      {error && <div role="alert" className="status-popover-error">{error}</div>}
      {bulkClear && failedJobs.length > 0 && <div className="transfer-clear-band" role="group" aria-label={t("transfer.clearFailed")}>
        <span className="transfer-clear-question">{t("transfer.clearFailedBulk", { count: failedJobs.length })}</span>
        <div className="transfer-job-actions">
          <button type="button" onClick={() => void clearJobs(failedJobs.map((job) => job.id))}>{t("transfer.dismiss")}</button>
          <button type="button" onClick={() => setBulkClear(false)}>{t("common.cancel")}</button>
        </div>
        <span className="transfer-clear-hint">{t("transfer.clearFailedHint")}</span>
      </div>}
      {jobs.length === 0 && recoverable.length === 0 && <p className="status-popover-note">{t("transfer.noTransfers")}</p>}
      {jobs.length > 0 && <>
        <p className="transfer-center-total">{totalsText}</p>
        <div className="transfer-center-jobs"><VirtualFileRows entries={jobRows} rowHeight={JOB_ROW_HEIGHT} resetKey="transfer-jobs">{(job) => {
          if (confirming === job.id && job.status === "error") {
            return <ClearFailedConfirm
              key={job.id}
              onConfirm={() => void clearFailed(job.id)}
              onCancel={() => cancelConfirm(job.id)}
            />;
          }
          const percent = job.total > 0 ? Math.min(100, job.transferred / job.total * 100) : 0;
          const meta = jobMeta(job);
          return <article className={`transfer-job is-${job.status}`} key={job.id}>
            <div className="transfer-job-head">
              <span className={`transfer-status is-${STATUS_TONE[job.status] ?? "idle"}`}>{statusLabel(job.status)}</span>
              <strong className="transfer-job-name" title={job.name}>{job.name}</strong>
              <div className="transfer-job-actions">
                {["queued", "running", "retrying"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "pause")}>{t("transfer.pause")}</button>}
                {job.status === "paused" && <button type="button" onClick={() => void control(job.id, "resume")}>{t("transfer.resume")}</button>}
                {job.status === "error" && <button type="button" onClick={() => void control(job.id, "retry")}>{t("transfer.retryUnfinished")}</button>}
                {job.status === "cancelled" && job.error && <button type="button" onClick={() => void control(job.id, "cancel")}>{t("transfer.retryCleanup")}</button>}
                {!["complete", "cancelled", "cancelling"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "cancel")}>{t("common.cancel")}</button>}
                {["complete", "cancelled"].includes(job.status) && !job.error && <button type="button" onClick={() => void control(job.id, "dismiss")}>{t("transfer.dismiss")}</button>}
                {job.status === "error" && <button type="button" data-clear-failed={job.id} onClick={() => setConfirming(job.id)}>{t("transfer.dismiss")}</button>}
              </div>
            </div>
            <div className="transfer-job-progress">
              <div
                className="transfer-job-track"
                role="progressbar"
                aria-label={t("transfer.jobProgress", { name: job.name })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
              ><span className="transfer-job-bar" style={{ width: `${percent}%` }} /></div>
              <span className="transfer-job-percent">{Math.round(percent)}%</span>
            </div>
            <div className="transfer-job-meta">
              <span className={job.error ? "transfer-job-meta-text is-error" : "transfer-job-meta-text"} title={meta}>{meta}</span>
              {job.failedFiles.length > 0 && <button
                type="button"
                className="transfer-job-failures"
                aria-expanded={failureJob === job.id}
                onClick={() => setFailureJob(failureJob === job.id ? null : job.id)}
              >{t("transfer.failedFilesCount", { count: job.failedFiles.length })}</button>}
            </div>
          </article>;
        }}</VirtualFileRows></div>
      </>}
      {failureJob && records[failureJob] && <section aria-label={t("transfer.failedFilesSection")} className="transfer-failures">
        <div className="transfer-section-head">
          <strong title={records[failureJob].name}>{records[failureJob].name} · {t("transfer.failedFilesCount", { count: failureRows.length })}</strong>
          <button type="button" className="transfer-icon-button" aria-label={t("transfer.closeFailedFiles")} onClick={() => setFailureJob(null)}><Icon name="close" /></button>
        </div>
        <div className="transfer-failure-rows"><VirtualFileRows entries={failureRows} rowHeight={FAILURE_ROW_HEIGHT} resetKey={failureJob}>{(file) => <div className="transfer-failure-row" title={file.message}>{file.message}</div>}</VirtualFileRows></div>
      </section>}
      {(recoverable.length > 0 || recoveryError) && <section className="transfer-recovery">
        <div className="transfer-section-head">
          <strong>{t("transfer.interrupted")}{recoverable.length > 0 ? ` (${recoverable.length})` : ""}</strong>
        </div>
        <p className="status-popover-note transfer-recovery-note">{t("transfer.recoveryNote")}</p>
        {recoveryError && <div role="alert" className="status-popover-error">{recoveryError}</div>}
        <div className="transfer-recovery-rows"><VirtualFileRows entries={recoveryRows} rowHeight={RECOVERY_ROW_HEIGHT} resetKey="recovery">{(entry) => {
          const whom = [entry.username, entry.host].filter(Boolean).join("@") + (entry.port ? `:${entry.port}` : "");
          // An unattributable journal says so once; there is no endpoint or
          // item count it could honestly report.
          const meta = entry.unrecognized
            ? t("transfer.unrecognized")
            : [entry.kind, whom || t("transfer.unknownEndpoint"), t("transfer.itemsCount", { count: entry.items })].filter(Boolean).join(" · ");
          return <article className="transfer-recovery-row" key={entry.id}>
            <div className="transfer-recovery-main">
              <strong title={entry.name}>{entry.name}</strong>
              <span className="transfer-job-meta-text" title={meta}>{meta}</span>
            </div>
            <div className="transfer-job-actions">
              {!entry.unrecognized && <button type="button" onClick={() => void recover(entry.id)}>{t("transfer.resume")}</button>}
              <button type="button" onClick={() => void forget(entry.id)}>{t("transfer.forget")}</button>
            </div>
          </article>;
        }}</VirtualFileRows></div>
      </section>}
      <details className="transfer-settings">
        <summary>{t("transfer.settings")}</summary>
        <div className="transfer-settings-grid">
          <label title={t("transfer.requestsHint")}>{t("transfer.requestsLabel")}
            <input aria-label={t("transfer.requestsLabel")} type="number" min={1} max={32} value={options.requests} onChange={(e) => {
              const requests = Number(e.target.value); if (!Number.isInteger(requests) || requests < 1 || requests > 32) return;
              const next = { ...options, requests }; setOptions(next); saveTransferOptions(next);
            }} />
          </label>
          <label title={t("transfer.chunkHint")}>{t("transfer.chunkLabel")}
            <input aria-label={t("transfer.chunkLabel")} type="number" min={16} max={256} value={options.chunkKib} onChange={(e) => {
              const chunkKib = Number(e.target.value); if (!Number.isInteger(chunkKib) || chunkKib < 16 || chunkKib > 256) return;
              const next = { ...options, chunkKib }; setOptions(next); saveTransferOptions(next);
            }} />
          </label>
          <label title={t("transfer.filesHint")}>{t("transfer.filesLabel")}
            <input aria-label={t("transfer.filesLabel")} type="number" min={1} max={32} value={options.files} onChange={(e) => {
              const files = Number(e.target.value); if (!Number.isInteger(files) || files < 1 || files > 32) return;
              const next = { ...options, files }; setOptions(next); saveTransferOptions(next);
            }} />
          </label>
          <label title={t("transfer.rateLimitHint")}>{t("transfer.rateLimitLabel")}
            <input aria-label={t("transfer.rateLimitLabel")} type="number" min={0} max={1048576} value={rateKib(options)} onChange={(e) => {
              const kib = Number(e.target.value); if (!Number.isInteger(kib) || kib < 0 || kib > 1048576) return;
              const rateLimitBps = kib * 1024; if (!validRateLimitBps(rateLimitBps)) return;
              const next = { ...options, rateLimitBps }; setOptions(next); saveTransferOptions(next);
            }} />
          </label>
          <label className="transfer-settings-toggle" title={t("transfer.durableHint")}>
            <input type="checkbox" checked={options.durable} onChange={(e) => {
              const next = { ...options, durable: e.target.checked }; setOptions(next); saveTransferOptions(next);
            }} /> {t("transfer.durableLabel")}
          </label>
          <label className="transfer-settings-toggle" title={t("transfer.tarHint")}>
            <input type="checkbox" checked={options.tar} onChange={(e) => {
              const next = { ...options, tar: e.target.checked }; setOptions(next); saveTransferOptions(next);
            }} /> {t("transfer.tarLabel")}
          </label>
        </div>
      </details>
    </StatusPopover>}
  </div>;
}
