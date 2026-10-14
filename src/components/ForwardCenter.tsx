import { memo, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { transferBytes } from "../fileTransfers";
import { useActiveTab } from "../store";
import { VirtualFileRows } from "./VirtualFileRows";
import { usePopoverDismiss } from "./usePopoverDismiss";

const defaults: api.PortForwardSpec = { direction: "local", listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort: 8080 };
const endpoint = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port || "auto"}`;
const active = (row: api.PortForward) => ["starting", "listening", "stopping"].includes(row.status);
const loopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());

export const ForwardCenter = memo(function ForwardCenter() {
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
      catch (e) { if (!disposed) setError(String(e)); }
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
      } catch (e) { if (!disposed && scan.current === requestId) setScanError(String(e)); }
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
    catch (e) { if (mounted.current && mutation.current === version) setError(String(e)); }
    finally { if (mounted.current && mutation.current === version) setBusy(false); }
  };
  const count = rows.filter(active).length;
  const valid = spec.listenHost.trim().length > 0 && spec.targetHost.trim().length > 0 && Number.isInteger(spec.listenPort) && spec.listenPort >= 0 && spec.listenPort <= 65535 && Number.isInteger(spec.targetPort) && spec.targetPort >= 1 && spec.targetPort <= 65535;
  return <div className="forward-center" ref={container}>
    <button type="button" className="status-item" aria-expanded={open} onClick={() => setOpen(!open)}>Tunnels{count ? ` (${count})` : ""}</button>
    {open && <section className="forward-popover" aria-label="SSH port forwarding">
      <div className="resource-heading"><strong>SSH port forwarding</strong><button type="button" aria-label="Close tunnels" onClick={() => setOpen(false)}>×</button></div>
      {error && <div role="alert">{error}</div>}
      {eligible && owner ? <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) void perform(() => api.startPortForward(owner, { ...spec, listenHost: spec.listenHost.trim(), targetHost: spec.targetHost.trim() })); }}>
        <p>New tunnel belongs to {tab.info.address}. Closing that tab stops its tunnels.</p>
        <label>Direction <select aria-label="Tunnel direction" value={spec.direction} onChange={(event) => setSpec({ ...spec, direction: event.target.value as api.PortForwardSpec["direction"] })}><option value="local">Local → SSH host (L)</option><option value="remote">SSH host → local (R)</option></select></label>
        <div className="forward-fields"><label>Listen on {spec.direction === "local" ? "this computer" : "SSH host"}<input aria-label="Tunnel listener host" value={spec.listenHost} onChange={(event) => setSpec({ ...spec, listenHost: event.target.value })} /></label><label>Port (0 = auto)<input aria-label="Tunnel listener port" type="number" min={0} max={65535} value={spec.listenPort} onChange={(event) => setSpec({ ...spec, listenPort: Number(event.target.value) })} /></label></div>
        <div className="forward-fields"><label>Target on {spec.direction === "local" ? "SSH host" : "this computer"}<input aria-label="Tunnel target host" value={spec.targetHost} onChange={(event) => setSpec({ ...spec, targetHost: event.target.value })} /></label><label>Port<input aria-label="Tunnel target port" type="number" min={1} max={65535} value={spec.targetPort} onChange={(event) => setSpec({ ...spec, targetPort: Number(event.target.value) })} /></label></div>
        {!loopback(spec.listenHost) && <p className="is-warning">This listener may accept connections from other computers. Remote binding also depends on the SSH server's GatewayPorts policy.</p>}
        {spec.direction === "remote" && loopback(spec.listenHost) && <p>The SSH server controls the final bind address. Its GatewayPorts policy can override the requested loopback binding.</p>}
        <button type="submit" disabled={!valid || busy}>Create tunnel</button>
      </form> : <p>Connect an SSH or SFTP tab to create tunnels and discover its listening ports.</p>}
      <h4>Remote listening ports</h4><button type="button" disabled={!eligible || scanning} onClick={() => setRefresh((value) => value + 1)}>Refresh ports</button>
      {scanning && <p>Reading remote listeners…</p>}{scanError && <div role="alert">{scanError}</div>}
      {discovery?.status === "unsupported" && <p>Listener discovery requires Linux with ss or netstat.</p>}
      {discovery?.status === "ok" && <><p>{discovery.ports.length} listeners{discovery.truncated ? " (result limit reached)" : ""}. Process names may require server permissions. Choose a port to fill the draft.</p><div className="forward-list forward-discovery">
        <VirtualFileRows entries={discovery.ports.map((port) => ({ ...port, path: `${port.host}:${port.port}` }))} rowHeight={38} resetKey={owner ?? ""}>{(port) => <div className="forward-listener" key={port.path}><span title={port.process ?? "Process unavailable"}>{endpoint(port.host, port.port)}{port.process && <small>{port.process}</small>}</span><button type="button" onClick={() => setSpec({ ...defaults, targetHost: port.host === "::" ? "::1" : ["*", "0.0.0.0"].includes(port.host) ? "127.0.0.1" : port.host, targetPort: port.port })}>Use port {port.port}</button></div>}</VirtualFileRows>
      </div></>}
      <h4>Tunnels · {rows.length}</h4><div className="forward-list forward-jobs">
        <VirtualFileRows entries={rows.map((row) => ({ ...row, path: row.id }))} rowHeight={136} resetKey="tunnels">{(row) => <article className="forward-job" key={row.id}>
          <strong>{row.spec.direction === "local" ? "L · Local → SSH host" : "R · SSH host → local"} · {row.status}</strong>
          <div className="forward-route"><span>{endpoint(row.spec.listenHost, row.spec.listenPort)}</span><span aria-hidden="true">→</span><span>{endpoint(row.spec.targetHost, row.spec.targetPort)}</span></div>
          <small title={row.owner}>{row.address} · tab {row.owner.slice(0, 8)} · {row.connections} connections</small>
          <small>Local → remote {transferBytes(row.sentBytes)} · remote → local {transferBytes(row.receivedBytes)}</small>
          {row.error && <div className="forward-error" title={row.error}>{row.error}</div>}
          <button type="button" disabled={busy || row.status === "stopping"} onClick={() => void perform(() => active(row) ? api.stopPortForward(row.id) : api.removePortForward(row.id))}>{active(row) ? "Stop tunnel" : "Remove tunnel"}</button>
        </article>}</VirtualFileRows>
      </div>
      <p>Listeners default to loopback. Active tunnels live only for this application session.</p>
      <p>Traffic counters count payload accepted by the local TCP and SSH streams; pending writes may not reach the peer after a connection failure.</p>
    </section>}
  </div>;
});
