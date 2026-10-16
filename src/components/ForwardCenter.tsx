import { memo, useEffect, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { transferBytes } from "../fileTransfers";
import { useActiveTab } from "../store";
import { VirtualFileRows } from "./VirtualFileRows";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";

const defaults: api.PortForwardSpec = { direction: "local", listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort: 8080 };
const endpoint = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port || "auto"}`;
const active = (row: api.PortForward) => ["starting", "listening", "stopping"].includes(row.status);
const loopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());

export const ForwardCenter = memo(function ForwardCenter() {
  const t = useT();
  const tab = useActiveTab();
  const owner = tab?.info.id;
  const eligible = tab?.state === "connected" && (tab.info.kind === "ssh" || tab.info.kind === "sftp");
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), container);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [rows, setRows] = useState<api.PortForward[]>([]);
  const [spec, setSpec] = useState(defaults);
  const [discovery, setDiscovery] = useState<api.PortDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const scan = useRef<string | null>(null);
  const mutation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  useEffect(() => { setSpec(defaults); setError(null); setBusy(false); ++mutation.current; }, [owner]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { const found = await api.listPortForwards(); if (!disposed) setRows(found); }
      catch (e) { if (!disposed) setError(errorText(e)); }
      finally { if (!disposed) timer = setTimeout(poll, open ? 1000 : 4000); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [open, visible, refresh]);
  useEffect(() => {
    setDiscovery(null); setScanError(null); setScanning(false);
    if (!open || !visible || !eligible || !owner) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const requestId = crypto.randomUUID(); scan.current = requestId; setScanning(true); let unsupported = false;
      try {
        const found = await api.discoverListeningPorts(owner, requestId);
        if (!disposed && scan.current === requestId) { setDiscovery(found); setScanError(null); unsupported = found.status === "unsupported"; }
      } catch (e) { if (!disposed && scan.current === requestId) setScanError(errorText(e)); }
      finally {
        if (!disposed && scan.current === requestId) { scan.current = null; setScanning(false); }
        if (!disposed && !unsupported) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); const requestId = scan.current; scan.current = null; if (requestId) void api.cancelPortDiscovery(requestId).catch(() => {}); };
  }, [open, visible, eligible, owner, refresh]);
  const perform = async (operation: () => Promise<unknown>) => {
    const version = ++mutation.current; setBusy(true); setError(null);
    try { await operation(); if (mounted.current && mutation.current === version) setRefresh((value) => value + 1); }
    catch (e) { if (mounted.current && mutation.current === version) setError(errorText(e)); }
    finally { if (mounted.current && mutation.current === version) setBusy(false); }
  };
  const count = rows.filter(active).length;
  const valid = spec.listenHost.trim().length > 0 && spec.targetHost.trim().length > 0 && Number.isInteger(spec.listenPort) && spec.listenPort >= 0 && spec.listenPort <= 65535 && Number.isInteger(spec.targetPort) && spec.targetPort >= 1 && spec.targetPort <= 65535;
  return <div className="forward-center" ref={container}>
    <button type="button" className="status-item" aria-expanded={open} onClick={() => setOpen(!open)}>{t("forward.tunnels")}{count ? ` (${count})` : ""}</button>
    {open && <section className="forward-popover" aria-label={t("forward.sshPortForwarding")}>
      <div className="resource-heading"><strong>{t("forward.sshPortForwarding")}</strong><button type="button" aria-label={t("forward.closeTunnels")} onClick={() => setOpen(false)}>×</button></div>
      {error && <div role="alert">{error}</div>}
      {eligible && owner ? <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) void perform(() => api.startPortForward(owner, { ...spec, listenHost: spec.listenHost.trim(), targetHost: spec.targetHost.trim() })); }}>
        <p>{t("forward.newTunnelOwner", { address: tab.info.address })}</p>
        <label>{t("forward.directionLabel")} <select aria-label={t("forward.directionAria")} value={spec.direction} onChange={(event) => setSpec({ ...spec, direction: event.target.value as api.PortForwardSpec["direction"] })}><option value="local">{t("forward.dirLocal")}</option><option value="remote">{t("forward.dirRemote")}</option></select></label>
        <div className="forward-fields"><label>{t("forward.listenOnLabel")} {spec.direction === "local" ? t("forward.thisComputer") : t("forward.sshHost")}<input aria-label={t("forward.listenerHostAria")} value={spec.listenHost} onChange={(event) => setSpec({ ...spec, listenHost: event.target.value })} /></label><label>{t("forward.portAutoLabel")}<input aria-label={t("forward.listenerPortAria")} type="number" min={0} max={65535} value={spec.listenPort} onChange={(event) => setSpec({ ...spec, listenPort: Number(event.target.value) })} /></label></div>
        <div className="forward-fields"><label>{t("forward.targetOnLabel")} {spec.direction === "local" ? t("forward.sshHost") : t("forward.thisComputer")}<input aria-label={t("forward.targetHostAria")} value={spec.targetHost} onChange={(event) => setSpec({ ...spec, targetHost: event.target.value })} /></label><label>{t("forward.portLabel")}<input aria-label={t("forward.targetPortAria")} type="number" min={1} max={65535} value={spec.targetPort} onChange={(event) => setSpec({ ...spec, targetPort: Number(event.target.value) })} /></label></div>
        {!loopback(spec.listenHost) && <p className="is-warning">{t("forward.listenerWarning")}</p>}
        {spec.direction === "remote" && loopback(spec.listenHost) && <p>{t("forward.gatewayNote")}</p>}
        <button type="submit" disabled={!valid || busy}>{t("forward.createTunnel")}</button>
      </form> : <p>{t("forward.connectHint")}</p>}
      <h4>{t("forward.remotePorts")}</h4><button type="button" disabled={!eligible || scanning} onClick={() => setRefresh((value) => value + 1)}>{t("forward.refreshPorts")}</button>
      {scanning && <p>{t("forward.readingListeners")}</p>}{scanError && <div role="alert">{scanError}</div>}
      {discovery?.status === "unsupported" && <p>{t("forward.discoveryUnsupported")}</p>}
      {discovery?.status === "ok" && <><p>{t("forward.listenersCount", { count: discovery.ports.length })}{discovery.truncated ? t("forward.resultLimitReached") : ""}{t("forward.listenersHint")}</p><div className="forward-list forward-discovery">
        <VirtualFileRows entries={discovery.ports.map((port) => ({ ...port, path: `${port.host}:${port.port}` }))} rowHeight={38} resetKey={owner ?? ""}>{(port) => <div className="forward-listener" key={port.path}><span title={port.process ?? t("forward.processUnavailable")}>{endpoint(port.host, port.port)}{port.process && <small>{port.process}</small>}</span><button type="button" onClick={() => setSpec({ ...defaults, targetHost: port.host === "::" ? "::1" : ["*", "0.0.0.0"].includes(port.host) ? "127.0.0.1" : port.host, targetPort: port.port })}>{t("forward.usePort", { port: port.port })}</button></div>}</VirtualFileRows>
      </div></>}
      <h4>{t("forward.tunnels")} · {rows.length}</h4><div className="forward-list forward-jobs">
        <VirtualFileRows entries={rows.map((row) => ({ ...row, path: row.id }))} rowHeight={136} resetKey="tunnels">{(row) => <article className="forward-job" key={row.id}>
          <strong>{row.spec.direction === "local" ? t("forward.jobLocal") : t("forward.jobRemote")} · {row.status}</strong>
          <div className="forward-route"><span>{endpoint(row.spec.listenHost, row.spec.listenPort)}</span><span aria-hidden="true">→</span><span>{endpoint(row.spec.targetHost, row.spec.targetPort)}</span></div>
          <small title={row.owner}>{row.address} · {t("forward.tabWord")} {row.owner.slice(0, 8)} · {t("forward.connectionsCount", { count: row.connections })}</small>
          <small>{t("forward.localToRemote")} {transferBytes(row.sentBytes)} · {t("forward.remoteToLocal")} {transferBytes(row.receivedBytes)}</small>
          {row.error && <div className="forward-error" title={row.error}>{row.error}</div>}
          <button type="button" disabled={busy || row.status === "stopping"} onClick={() => void perform(() => active(row) ? api.stopPortForward(row.id) : api.removePortForward(row.id))}>{active(row) ? t("forward.stopTunnel") : t("forward.removeTunnel")}</button>
        </article>}</VirtualFileRows>
      </div>
      <p>{t("forward.loopbackNote")}</p>
      <p>{t("forward.trafficNote")}</p>
    </section>}
  </div>;
});
