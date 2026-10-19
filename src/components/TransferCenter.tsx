import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { startTransferSubscription, transferActive, transferBytes, useFileTransfers } from "../fileTransfers";
import { Icon } from "./icons";
import { readTransferOptions, saveTransferOptions, validRateLimitBps } from "../transferSettings";
import { useStore } from "../store";
import { VirtualFileRows } from "./VirtualFileRows";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";
import type { MessageKey } from "../i18n";

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

export function TransferCenter() {
  const t = useT();
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL[status];
    return key ? t(key) : status;
  };
  const kindLabel = (kind: string | null) =>
    kind === "upload"
      ? t("transfer.kindUpload")
      : kind === "download"
        ? t("transfer.kindDownload")
        : (kind ?? "");
  const records = useFileTransfers((s) => s.jobs);
  const open = useFileTransfers((s) => s.open);
  const setOpen = useFileTransfers((s) => s.setOpen);
  const container=useRef<HTMLDivElement>(null);
  usePopoverDismiss(open,()=>setOpen(false),container);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(readTransferOptions);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setOptions(readTransferOptions()), [preferencesRevision]);
  const [recoverable, setRecoverable] = useState<api.RecoverableTransfer[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [failureJob, setFailureJob] = useState<string | null>(null);
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
  const jobs = useMemo(() => Object.values(records).sort((a, b) => b.id.localeCompare(a.id)),[records]);
  const jobRows = useMemo(() => jobs.map((job) => ({ ...job, path: job.id })),[jobs]);
  const active = jobs.filter((j) => transferActive(j.status)).length;
  const failed = jobs.filter((j) => j.status === "error").length;
  // One line for the whole queue: the cards below carry the per-job detail,
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
  // What the status bar item says. Running work counts first, then failures;
  // an interrupted transfer waiting to be resumed names itself, because the
  // popover that would tell the user is closed until asked for.
  const statusCount = active > 0
    ? ` (${active})`
    : failed > 0
      ? t("transfer.failedCountParen", { count: failed })
      : recoverable.length > 0
        ? ` (${recoverable.length})`
        : "";
  const statusName = active > 0 || failed > 0 || recoverable.length === 0
    ? t("transfer.transfers")
    : t("transfer.interrupted");
  const statusTitle = [
    t("transfer.backgroundTitle"),
    active > 0 ? ` (${active})` : "",
    failed > 0 ? t("transfer.failedCountParen", { count: failed }) : "",
    recoverable.length > 0 ? ` · ${t("transfer.interrupted")} (${recoverable.length})` : "",
  ].join("");
  const control = async (id: string, action: Parameters<typeof api.controlFileTransfer>[1]) => {
    setError(null);
    try {
      await api.controlFileTransfer(id, action);
      if (action === "dismiss") useFileTransfers.getState().remove(id);
    } catch (e) { setError(errorText(e)); }
  };
  return <div className="transfer-center" ref={container}>
    <button
      className={`status-item${failed > 0 ? " is-error" : ""}`}
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      title={statusTitle}
    >
      <Icon name="cloud-download" /> {statusName}{statusCount}
    </button>
    {open && <section className="transfer-center-popover" aria-label={t("transfer.backgroundTitle")}>
      <div className="transfer-center-heading"><strong>{t("transfer.transfers")}</strong><button type="button" onClick={() => setOpen(false)} aria-label={t("transfer.closeTransfers")}>×</button></div>
      <p>{t("transfer.intro")}</p>
      <details className="transfer-settings"><summary>{t("transfer.settingsSummary")}</summary>
        <div className="transfer-job-actions">
          <label>{t("transfer.requestsLabel")} <input aria-label={t("transfer.requestsLabel")} type="number" min={1} max={32} value={options.requests} onChange={(e) => {
            const requests = Number(e.target.value); if (!Number.isInteger(requests) || requests < 1 || requests > 32) return;
            const next = { ...options, requests }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label>{t("transfer.chunkLabel")} <input aria-label={t("transfer.chunkAria")} type="number" min={16} max={256} value={options.chunkKib} onChange={(e) => {
            const chunkKib = Number(e.target.value); if (!Number.isInteger(chunkKib) || chunkKib < 16 || chunkKib > 256) return;
            const next = { ...options, chunkKib }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label>{t("transfer.filesLabel")} <input aria-label={t("transfer.concurrentFilesAria")} type="number" min={1} max={32} value={options.files} onChange={(e) => {
            const files = Number(e.target.value); if (!Number.isInteger(files) || files < 1 || files > 32) return;
            const next = { ...options, files }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label>{t("transfer.rateLimitLabel")} <input aria-label={t("transfer.rateLimitAria")} type="number" min={0} max={1048576} value={rateKib(options)} onChange={(e) => {
            const kib = Number(e.target.value); if (!Number.isInteger(kib) || kib < 0 || kib > 1048576) return;
            const rateLimitBps = kib * 1024; if (!validRateLimitBps(rateLimitBps)) return;
            const next = { ...options, rateLimitBps }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label className="transfer-durable"><input aria-label={t("transfer.durableAria")} type="checkbox" checked={options.durable} onChange={(e) => {
            const next = { ...options, durable: e.target.checked }; setOptions(next); saveTransferOptions(next);
          }} /> {t("transfer.durableLabel")}</label>
          <label className="transfer-durable"><input aria-label={t("transfer.tarAria")} type="checkbox" checked={options.tar} onChange={(e) => {
            const next = { ...options, tar: e.target.checked }; setOptions(next); saveTransferOptions(next);
          }} /> {t("transfer.tarLabel")}</label>
        </div><p>{t("transfer.settingsNote")}</p>
        <p>{t("transfer.rateLimitNote")}</p>
        <p>{t("transfer.tarNote1")}<code>tar -xf -</code>{t("transfer.tarNote2")}<code>-k</code>{t("transfer.tarNote3")}</p>
      </details>
      {error && <div role="alert" className="transfer-job-error">{error}</div>}
      {(recoveryError || recoverable.length > 0) && <details className="transfer-recovery" open>
        <summary>{t("transfer.interrupted")}{recoverable.length > 0 ? ` (${recoverable.length})` : ""}</summary>
        <p>{t("transfer.recoveryNote")}</p>
        {recoveryError && <div role="alert" className="transfer-job-error">{recoveryError}</div>}
        <div className="transfer-recovery-rows"><VirtualFileRows entries={recoveryRows} rowHeight={112} resetKey="recovery">{(entry) => {
          const whom = [entry.username, entry.host].filter(Boolean).join("@") + (entry.port ? `:${entry.port}` : "");
          return <article className="transfer-job" key={entry.id}>
          <div className="transfer-job-title"><strong title={entry.name}>{entry.name}</strong><span>{entry.unrecognized ? t("transfer.unrecognized") : kindLabel(entry.kind)}</span></div>
          <div className="transfer-job-details">{entry.unrecognized
            ? t("transfer.unrecognizedNote")
            : `${whom || t("transfer.unknownEndpoint")} · ${t("transfer.itemsCount", { count: entry.items })} · ${t("transfer.checkpointsCount", { count: entry.checkpoints })}`}</div>
          {!entry.unrecognized && <div className="transfer-job-actions">
            <button type="button" onClick={() => void recover(entry.id)}>{t("transfer.resume")}</button>
            <button type="button" onClick={() => void forget(entry.id)}>{t("transfer.forget")}</button>
          </div>}
          {entry.unrecognized && <div className="transfer-job-actions">
            <button type="button" onClick={() => void forget(entry.id)}>{t("transfer.forget")}</button>
          </div>}
        </article>; }}</VirtualFileRows></div>
      </details>}
      {jobs.length === 0 && recoverable.length === 0 && <p>{t("transfer.noTransfers")}</p>}
      {jobs.length > 0 && <div className="transfer-center-total">
        <strong>{t("transfer.transfers")}</strong>
        <span>{t("transfer.filesCount", { done: queueTotals.done, total: queueTotals.total })}</span>
        <span>{transferBytes(queueTotals.transferred)} / {transferBytes(queueTotals.bytes)}</span>
        {queueTotals.rate > 0 && <span>{transferBytes(queueTotals.rate)}/s</span>}
        {queueEta !== null && <span>{t("transfer.etaRemaining", { seconds: queueEta })}</span>}
      </div>}
      <div className="transfer-center-jobs">
        <VirtualFileRows entries={jobRows} rowHeight={192} resetKey="transfer-jobs">{(job) => {
          const percent = job.total > 0 ? Math.min(100, job.transferred / job.total * 100) : 0;
          const eta = job.bytesPerSecond > 0 && job.total > job.transferred ? Math.ceil((job.total - job.transferred) / job.bytesPerSecond) : null;
          const limit = job.options.rateLimitBps > 0 ? t("transfer.rateLimit", { value: transferBytes(job.options.rateLimitBps) }) : t("transfer.noLimit");
          return <article className="transfer-job" key={job.id}>
            <div className="transfer-job-title"><strong title={job.name}>{job.name}</strong><span>{statusLabel(job.status)}</span></div>
            <div className="transfer-job-details">{t("transfer.filesCount", { done: job.completedFiles, total: job.totalFiles })} · {transferBytes(job.transferred)} / {transferBytes(job.total)}</div>
            <progress max={100} value={percent} aria-label={t("transfer.jobProgress", { name: job.name })} />
            {job.status === "running" && <div className="transfer-job-details">{transferBytes(job.bytesPerSecond)}/s · {limit}{eta !== null ? t("transfer.etaRemaining", { seconds: eta }) : ""}</div>}
            {job.status !== "running" && job.options.rateLimitBps > 0 && <div className="transfer-job-details">{limit}{t("transfer.limitKept")}</div>}
            {job.error && <div className="transfer-job-error transfer-job-message" title={job.error.message}>{job.error.message}</div>}
            {job.failedFiles.length > 0 && <button type="button" className="transfer-failure-button" onClick={() => setFailureJob(failureJob === job.id ? null : job.id)}>{t("transfer.viewFailedFiles", { count: job.failedFiles.length })}</button>}
            <div className="transfer-job-actions">
              {["queued", "running", "retrying"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "pause")}>{t("transfer.pause")}</button>}
              {job.status === "paused" && <button type="button" onClick={() => void control(job.id, "resume")}>{t("transfer.resume")}</button>}
              {job.status === "error" && <button type="button" onClick={() => void control(job.id, "retry")}>{t("transfer.retryUnfinished")}</button>}
              {!["complete", "cancelled", "cancelling"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "cancel")}>{t("common.cancel")}</button>}
              {job.status === "cancelled" && job.error && <button type="button" onClick={() => void control(job.id, "cancel")}>{t("transfer.retryCleanup")}</button>}
              {["complete", "cancelled"].includes(job.status) && !job.error && <button type="button" onClick={() => void control(job.id, "dismiss")}>{t("transfer.dismiss")}</button>}
            </div>
          </article>;
        }}</VirtualFileRows>
      </div>
      {failureJob && records[failureJob] && <section aria-label={t("transfer.failedFilesSection")} className="transfer-failures">
        <div className="transfer-center-heading"><strong title={records[failureJob].name}>{records[failureJob].name} · {t("transfer.failedFilesCount", { count: failureRows.length })}</strong><button type="button" aria-label={t("transfer.closeFailedFiles")} onClick={() => setFailureJob(null)}>×</button></div>
        <div className="transfer-failure-rows"><VirtualFileRows entries={failureRows} rowHeight={40} resetKey={failureJob}>{(file) => <div className="transfer-failure-row" title={file.message}>{file.message}</div>}</VirtualFileRows></div>
      </section>}
    </section>}
  </div>;
}
