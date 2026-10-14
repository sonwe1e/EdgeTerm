import { useEffect, useState } from "react";
import * as api from "../api";
import { startTransferSubscription, transferActive, transferBytes, useFileTransfers } from "../fileTransfers";
import { Icon } from "./icons";
import { readTransferOptions, saveTransferOptions } from "../transferSettings";
import { useStore } from "../store";

export function TransferCenter() {
  const records = useFileTransfers((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(readTransferOptions);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setOptions(readTransferOptions()), [preferencesRevision]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void startTransferSubscription().then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; stop?.(); };
  }, []);
  const jobs = Object.values(records).sort((a, b) => b.id.localeCompare(a.id));
  const active = jobs.filter((j) => transferActive(j.status)).length;
  const failed = jobs.filter((j) => j.status === "error").length;
  const control = async (id: string, action: Parameters<typeof api.controlFileTransfer>[1]) => {
    setError(null);
    try {
      await api.controlFileTransfer(id, action);
      if (action === "dismiss") useFileTransfers.getState().remove(id);
    } catch (e) { setError(String(e)); }
  };
  return <div className="transfer-center">
    <button className="status-item" type="button" aria-expanded={open} onClick={() => setOpen(!open)} title="Background transfers">
      <Icon name="cloud-download" /> Transfers{active > 0 ? ` (${active})` : failed > 0 ? ` (${failed} failed)` : ""}
    </button>
    {open && <section className="transfer-center-popover" aria-label="Background transfers">
      <div className="transfer-center-heading"><strong>Transfers</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close transfers">×</button></div>
      <p>Transfers continue while this app is open, including when you switch tabs. Pause keeps partial files; Cancel cleans them up when the server is reachable.</p>
      <details className="transfer-settings"><summary>Settings for new transfers</summary>
        <div className="transfer-job-actions">
          <label>SFTP requests <input aria-label="SFTP requests" type="number" min={1} max={32} value={options.requests} onChange={(e) => {
            const requests = Number(e.target.value); if (!Number.isInteger(requests) || requests < 1 || requests > 32) return;
            const next = { ...options, requests }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label>Chunk (KiB) <input aria-label="Chunk size in KiB" type="number" min={16} max={256} value={options.chunkKib} onChange={(e) => {
            const chunkKib = Number(e.target.value); if (!Number.isInteger(chunkKib) || chunkKib < 16 || chunkKib > 256) return;
            const next = { ...options, chunkKib }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label>Files <input aria-label="Concurrent files" type="number" min={1} max={32} value={options.files} onChange={(e) => {
            const files = Number(e.target.value); if (!Number.isInteger(files) || files < 1 || files > 32) return;
            const next = { ...options, files }; setOptions(next); saveTransferOptions(next);
          }} /></label>
          <label className="transfer-durable"><input aria-label="Flush each file on the server before committing" type="checkbox" checked={options.durable} onChange={(e) => {
            const next = { ...options, durable: e.target.checked }; setOptions(next); saveTransferOptions(next);
          }} /> Durable writes (fsync)</label>
          <label className="transfer-durable"><input aria-label="Stream folder uploads as a tar archive" type="checkbox" checked={options.tar} onChange={(e) => {
            const next = { ...options, tar: e.target.checked }; setOptions(next); saveTransferOptions(next);
          }} /> Tar stream for folder uploads</label>
        </div><p>Server limits may lower these values. FTP uses up to two file connections. Durable writes require SFTP server support; uploads fail if the server cannot confirm a flush. This option does not apply to downloads.</p>
        <p>Tar stream packs a folder upload into one archive and pipes it into <code>tar -xf -</code> on the server. It needs a remote tar with <code>-k</code> and a POSIX shell, and only works for a folder upload into a target directory that does not exist or is empty. There is no per-file resume, no per-file conflict detection and no atomic commit: progress counts the bytes packed on this machine, cancelling leaves whatever tar had already extracted, and a retry starts the whole folder again. Folder names are sent as UTF-8, so a server whose locale is not UTF-8 stores them mangled.</p>
      </details>
      {error && <div role="alert" className="transfer-job-error">{error}</div>}
      {jobs.length === 0 && <p>No transfers yet.</p>}
      <div className="transfer-center-jobs">
        {jobs.map((job) => {
          const percent = job.total > 0 ? Math.min(100, job.transferred / job.total * 100) : 0;
          const eta = job.bytesPerSecond > 0 && job.total > job.transferred ? Math.ceil((job.total - job.transferred) / job.bytesPerSecond) : null;
          return <article className="transfer-job" key={job.id}>
            <div className="transfer-job-title"><strong title={job.name}>{job.name}</strong><span>{job.status}</span></div>
            <div className="transfer-job-details">{job.phase} · {job.completedFiles}/{job.totalFiles} files · {transferBytes(job.transferred)} / {transferBytes(job.total)}</div>
            <progress max={100} value={percent} aria-label={`${job.name} progress`} />
            {job.status === "running" && <div className="transfer-job-details">{transferBytes(job.bytesPerSecond)}/s{eta !== null ? ` · about ${eta}s remaining` : ""}</div>}
            {job.error && <div className="transfer-job-error">{job.error.message}</div>}
            {job.failedFiles.length > 0 && <details><summary>{job.failedFiles.length} failed file(s)</summary><ul>{job.failedFiles.map((file, i) => <li key={i}>{file}</li>)}</ul></details>}
            <div className="transfer-job-actions">
              {["queued", "running", "retrying"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "pause")}>Pause</button>}
              {job.status === "paused" && <button type="button" onClick={() => void control(job.id, "resume")}>Resume</button>}
              {job.status === "error" && <button type="button" onClick={() => void control(job.id, "retry")}>Retry unfinished files</button>}
              {!["complete", "cancelled", "cancelling"].includes(job.status) && <button type="button" onClick={() => void control(job.id, "cancel")}>Cancel</button>}
              {job.status === "cancelled" && job.error && <button type="button" onClick={() => void control(job.id, "cancel")}>Retry cleanup</button>}
              {["complete", "cancelled"].includes(job.status) && !job.error && <button type="button" onClick={() => void control(job.id, "dismiss")}>Dismiss</button>}
            </div>
          </article>;
        })}
      </div>
    </section>}
  </div>;
}
