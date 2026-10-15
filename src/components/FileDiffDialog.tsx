import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api";
import { VirtualFileRows } from "./VirtualFileRows";
import { useStableCallback } from "../useStableCallback";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

const ROW_HEIGHT = 28;
export function FileDiffDialog({ sessionId, local, remote, active, onClose }: {
  sessionId: string; local: string; remote: string; active: boolean; onClose: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<api.FileComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<string | null>(null);
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
  const columnWidth = useMemo(() => Math.max(280, (result?.rows.reduce((max, row) => Math.max(max,
    (row.left ?? "").replace(/\t/g, "        ").replace(/[^\x00-\x7f]/g, "xx").length,
    (row.right ?? "").replace(/\t/g, "        ").replace(/[^\x00-\x7f]/g, "xx").length), 0) ?? 0) * 8 + 100), [result]);
  if (!active) return null;
  const cancel = () => {
    const id = pending.current;
    pending.current = null; setLoading(false); setError(t("diff.cancelled"));
    if (id) void api.cancelFileDiff(id).catch((e) => setError(t("diff.cancelFailed", { error: String(e) })));
  };
  const jump = (end: boolean) => scroller.current?.scrollTo({ top: end ? scroller.current.scrollHeight : 0 });
  return <ModalDialog open={active} bare role="dialog" ariaLabel={t("diff.dialogAria")} contentClassName="file-diff-dialog" onClose={close}>
    <div className="file-diff-heading" id="file-diff-title"><strong>{t("diff.heading")}</strong><button type="button" onClick={close} aria-label={t("diff.closeAria")}>×</button></div>
      <div className="file-diff-paths"><div title={local}><strong>{t("diff.localLabel")}</strong> {local}</div><div title={remote}><strong>{t("diff.remoteLabel")}</strong> {remote}</div></div>
      <div className="file-diff-toolbar">
        <span role="status">{loading ? t("diff.readingFiles") : result?.status === "identical" ? t("diff.identical") : result?.status === "different" ? t("diff.differ") : result ? t("diff.notComplete") : t("diff.stopped")}</span>
        {loading ? <button type="button" onClick={cancel}>{t("diff.cancelComparison")}</button> : <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t("diff.compareAgain")}</button>}
        <button type="button" disabled={!result?.rows.length} onClick={() => jump(false)}>{t("diff.firstLine")}</button>
        <button type="button" disabled={!result?.rows.length} onClick={() => jump(true)}>{t("diff.lastLine")}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && <>
        <div className="file-diff-metadata"><Metadata metadata={result.left} /><Metadata metadata={result.right} /></div>
        {result.reason && <p className="file-diff-notice">{result.reason}</p>}
        {result.alignmentSimplified && <p className="file-diff-notice">{t("diff.alignmentNote")}</p>}
        {result.rows.length === 0 ? <div className="file-diff-empty">{result.left.kind === "text" && result.right.kind === "text" ? t("diff.emptyFiles") : <><div>{t("diff.localHex")} {result.left.preview || t("diff.unavailable")}</div><div>{t("diff.remoteHex")} {result.right.preview || t("diff.unavailable")}</div></>}</div> :
          <div className="file-diff-rows" ref={scroller} tabIndex={0} aria-label={t("diff.linesAria")} style={{ "--diff-columns-width": `${columnWidth * 2}px` } as CSSProperties}>
            <VirtualFileRows entries={result.rows} rowHeight={ROW_HEIGHT} resetKey={`${sessionId}:${local}:${remote}:${attempt}`}>
              {(row) => <div className={`file-diff-row is-${row.kind}`} data-diff-row={row.path}>
                <div className="file-diff-cell"><span className="file-diff-number">{row.leftLine}</span><span className="file-diff-code">{row.left}</span><span className="file-diff-ending">{row.leftEnding}</span></div>
                <div className="file-diff-cell"><span className="file-diff-number">{row.rightLine}</span><span className="file-diff-code">{row.right}</span><span className="file-diff-ending">{row.rightEnding}</span></div>
              </div>}
            </VirtualFileRows>
          </div>}
      </>}
  </ModalDialog>;
}
function Metadata({ metadata }: { metadata: api.DiffMetadata }) {
  const t = useT();
  return <div>{metadata.size.toLocaleString()} B · {metadata.encoding ?? metadata.kind} · {metadata.eol}
    {metadata.bom && " · BOM"}{metadata.finalNewline === false && t("diff.noFinalNewline")}
    {metadata.lines !== null && t("diff.linesCount", { count: metadata.lines.toLocaleString() })}
    {metadata.sha256 && <small title={metadata.sha256}>{t("diff.sha256", { hash: metadata.sha256.slice(0, 16) })}</small>}
  </div>;
}
