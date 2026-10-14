import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api";
import { VirtualFileRows } from "./VirtualFileRows";
import { useStableCallback } from "../useStableCallback";

const ROW_HEIGHT = 28;
export function FileDiffDialog({ sessionId, local, remote, active, onClose }: {
  sessionId: string; local: string; remote: string; active: boolean; onClose: () => void;
}) {
  const [result, setResult] = useState<api.FileComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const close = useStableCallback(onClose);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const requestId = crypto.randomUUID();
    pending.current = requestId;
    setResult(null); setError(null); setLoading(true);
    void api.compareFiles(sessionId, requestId, local, remote).then((found) => {
      if (!disposed && pending.current === requestId) {
        pending.current = null; setResult(found); setLoading(false);
      }
    }).catch((e) => {
      if (!disposed && pending.current === requestId) {
        pending.current = null; setError(String(e)); setLoading(false);
      }
    });
    return () => {
      disposed = true;
      if (pending.current === requestId) {
        pending.current = null;
        void api.cancelFileDiff(requestId).catch(() => {});
      }
    };
  }, [sessionId, local, remote, active, attempt]);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const targets = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]') ?? [])];
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [active, close]);
  const columnWidth = useMemo(() => Math.max(280, (result?.rows.reduce((max, row) => Math.max(max,
    (row.left ?? "").replace(/\t/g, "        ").replace(/[^\x00-\x7f]/g, "xx").length,
    (row.right ?? "").replace(/\t/g, "        ").replace(/[^\x00-\x7f]/g, "xx").length), 0) ?? 0) * 8 + 100), [result]);
  if (!active) return null;
  const cancel = () => {
    const id = pending.current;
    pending.current = null; setLoading(false); setError("Comparison cancelled.");
    if (id) void api.cancelFileDiff(id).catch((e) => setError(`Cancellation failed: ${String(e)}`));
  };
  const jump = (end: boolean) => scroller.current?.scrollTo({ top: end ? scroller.current.scrollHeight : 0 });
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="file-diff-dialog" role="dialog" aria-modal="true" aria-label="Local and remote file comparison" ref={dialog}>
      <div className="file-diff-heading"><strong>Compare files · Read only</strong><button type="button" onClick={close} aria-label="Close file comparison">×</button></div>
      <div className="file-diff-paths"><div title={local}><strong>Local</strong> {local}</div><div title={remote}><strong>Remote</strong> {remote}</div></div>
      <div className="file-diff-toolbar">
        <span role="status">{loading ? "Reading files…" : result?.status === "identical" ? "Identical bytes" : result?.status === "different" ? "Files differ" : result ? "Not completely compared" : "Comparison stopped"}</span>
        {loading ? <button type="button" onClick={cancel}>Cancel comparison</button> : <button type="button" onClick={() => setAttempt((n) => n + 1)}>Compare again</button>}
        <button type="button" disabled={!result?.rows.length} onClick={() => jump(false)}>First line</button>
        <button type="button" disabled={!result?.rows.length} onClick={() => jump(true)}>Last line</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && <>
        <div className="file-diff-metadata"><Metadata metadata={result.left} /><Metadata metadata={result.right} /></div>
        {result.reason && <p className="file-diff-notice">{result.reason}</p>}
        {result.alignmentSimplified && <p className="file-diff-notice">Some distant changes are grouped together.</p>}
        {result.rows.length === 0 ? <div className="file-diff-empty">{result.left.kind === "text" && result.right.kind === "text" ? "Empty files." : <><div>Local hex: {result.left.preview || "unavailable"}</div><div>Remote hex: {result.right.preview || "unavailable"}</div></>}</div> :
          <div className="file-diff-rows" ref={scroller} tabIndex={0} aria-label="Comparison lines" style={{ "--diff-columns-width": `${columnWidth * 2}px` } as CSSProperties}>
            <VirtualFileRows entries={result.rows} rowHeight={ROW_HEIGHT} resetKey={`${sessionId}:${local}:${remote}:${attempt}`}>
              {(row) => <div className={`file-diff-row is-${row.kind}`} data-diff-row={row.path}>
                <div className="file-diff-cell"><span className="file-diff-number">{row.leftLine}</span><span className="file-diff-code">{row.left}</span><span className="file-diff-ending">{row.leftEnding}</span></div>
                <div className="file-diff-cell"><span className="file-diff-number">{row.rightLine}</span><span className="file-diff-code">{row.right}</span><span className="file-diff-ending">{row.rightEnding}</span></div>
              </div>}
            </VirtualFileRows>
          </div>}
      </>}
    </div>
  </div>;
}
function Metadata({ metadata }: { metadata: api.DiffMetadata }) {
  return <div>{metadata.size.toLocaleString()} B · {metadata.encoding ?? metadata.kind} · {metadata.eol}
    {metadata.bom && " · BOM"}{metadata.finalNewline === false && " · no final newline"}
    {metadata.lines !== null && ` · ${metadata.lines.toLocaleString()} lines`}
    {metadata.sha256 && <small title={metadata.sha256}>SHA-256 {metadata.sha256.slice(0, 16)}…</small>}
  </div>;
}
