import { useEffect, useState } from "react";
import * as api from "../api";
import { startTransferSubscription, transferActive, transferBytes, useFileTransfers } from "../fileTransfers";
import { Icon } from "./icons";
import { readTransferOptions, saveTransferOptions } from "../transferSettings";

export function TransferCenter() {
  const records = useFileTransfers((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(readTransferOptions);
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
          <label>Files <input aria-label="Concurrent files" type="number" min={1} max={8} value={options.files} onChange={(e) => {
            const files = Number(e.target.value); if (!Number.isInteger(files) || files < 1 || files > 8) return;
            const next = { ...options, files }; setOptions(next); saveTransferOptions(next);
          }} /></label>
        </div><p>Server limits may lower these values. FTP uses up to two file connections.</p>
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
