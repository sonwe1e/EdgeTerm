import { memo, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { transferBytes } from "../fileTransfers";
import { useActiveTab, useStore } from "../store";
import { VirtualFileRows } from "./VirtualFileRows";
import { StatusPopover } from "./StatusPopover";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";
import type { MessageKey } from "../i18n";

const defaults: api.PortForwardSpec = { direction: "local", listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort: 8080 };
const DIRECTIONS: readonly api.PortForwardSpec["direction"][] = ["local", "remote", "dynamic"];
const DIRECTION_LABEL: Record<api.PortForwardSpec["direction"], MessageKey> = {
  local: "forward.dirLocal",
  remote: "forward.dirRemote",
  dynamic: "forward.dirDynamic",
};
const DIRECTION_BADGE: Record<api.PortForwardSpec["direction"], MessageKey> = {
  local: "forward.badgeLocal",
  remote: "forward.badgeRemote",
  dynamic: "forward.badgeDynamic",
};
const STATUS_LABEL: Record<string, MessageKey> = {
  starting: "forward.statusStarting",
  listening: "forward.statusListening",
  stopping: "forward.statusStopping",
  stopped: "forward.statusStopped",
  error: "forward.statusError",
};
const DISCOVERY_ID = "forward-discovery";

const active = (row: api.PortForward) => ["starting", "listening", "stopping"].includes(row.status);
const loopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
const endpoint = (host: string, port: number, auto: string) => `${host.includes(":") ? `[${host}]` : host}:${port || auto}`;

export const ForwardCenter = memo(function ForwardCenter() {
  const t = useT();
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL[status];
    return key ? t(key) : status;
  };
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
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
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
    // Scanning only runs while the picker is expanded: a collapsed section
    // must not keep asking the server for listeners.
    if (!open || !discoveryOpen || !visible || !eligible || !owner) return;
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
  }, [open, discoveryOpen, visible, eligible, owner, refresh]);
  const perform = async (operation: () => Promise<unknown>) => {
    const version = ++mutation.current; setBusy(true); setError(null);
    try { await operation(); if (mounted.current && mutation.current === version) setRefresh((value) => value + 1); }
    catch (e) { if (mounted.current && mutation.current === version) setError(errorText(e)); }
    finally { if (mounted.current && mutation.current === version) setBusy(false); }
  };
  const count = rows.filter(active).length;
  const dynamic = spec.direction === "dynamic";
  const valid = spec.listenHost.trim().length > 0 && Number.isInteger(spec.listenPort) && spec.listenPort >= 0 && spec.listenPort <= 65535 && (dynamic || ((spec.targetHost?.trim().length ?? 0) > 0 && Number.isInteger(spec.targetPort) && (spec.targetPort ?? 0) >= 1 && (spec.targetPort ?? 0) <= 65535));
  const auto = t("forward.autoPort");
  // The card is three short lines, so its height follows the panel font the
  // same way the Filer's rows do; the virtual row pitch has to match the box.
  const panelFontSize = useStore((state) => state.panelFontSize);
  const jobRowHeight = Math.max(78, Math.round((panelFontSize - 1) * 3.6) + 36);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!owner || !valid || busy) return;
    void perform(() => api.startPortForward(owner, dynamic
      ? { direction: "dynamic", listenHost: spec.listenHost.trim(), listenPort: spec.listenPort }
      : { ...spec, listenHost: spec.listenHost.trim(), targetHost: (spec.targetHost ?? "").trim() }));
  };
  return <div className="forward-center" ref={container}>
    <button type="button" className="status-item" aria-expanded={open} onClick={() => setOpen(!open)}>{t("forward.tunnels")}{count ? ` (${count})` : ""}</button>
    {open && <StatusPopover
      className="forward-popover"
      label={t("forward.sshPortForwarding")}
      title={t("forward.sshPortForwarding")}
      closeLabel={t("forward.closeTunnels")}
      onClose={() => setOpen(false)}
    >
      {error && <div role="alert" className="status-popover-error">{error}</div>}
      {eligible && owner ? <form className="forward-form" onSubmit={submit}>
        <fieldset className="forward-directions">
          <legend className="sr-only">{t("forward.directionAria")}</legend>
          {DIRECTIONS.map((direction) => <label key={direction} className="forward-direction">
            <input type="radio" name="forward-direction" value={direction} checked={spec.direction === direction} onChange={() => setSpec({ ...spec, direction })} />
            <span>{t(DIRECTION_LABEL[direction])}</span>
          </label>)}
        </fieldset>
        <div className="forward-endpoints">
          <div className="forward-endpoint" aria-hidden="true">
            <span />
            <span className="forward-column">{t("forward.hostColumn")}</span>
            <span className="forward-column">{t("forward.portColumn")}</span>
          </div>
          <div className="forward-endpoint">
            <span className="forward-endpoint-label">{t("forward.listenRow")}</span>
            <input aria-label={t("forward.listenerHostAria")} value={spec.listenHost} onChange={(event) => setSpec({ ...spec, listenHost: event.target.value })} />
            <input aria-label={t("forward.listenerPortAria")} type="number" min={0} max={65535} placeholder={auto} value={spec.listenPort || ""} onChange={(event) => setSpec({ ...spec, listenPort: event.target.value === "" ? 0 : Number(event.target.value) })} />
          </div>
          {!dynamic && <div className="forward-endpoint">
            <span className="forward-endpoint-label">{t("forward.targetRow")}</span>
            <input aria-label={t("forward.targetHostAria")} value={spec.targetHost ?? ""} onChange={(event) => setSpec({ ...spec, targetHost: event.target.value })} />
            <input aria-label={t("forward.targetPortAria")} type="number" min={1} max={65535} value={spec.targetPort || ""} onChange={(event) => setSpec({ ...spec, targetPort: event.target.value === "" ? 0 : Number(event.target.value) })} />
          </div>}
        </div>
        {(!loopback(spec.listenHost) || dynamic || spec.direction === "remote") && <div className="forward-notes">
          {!loopback(spec.listenHost) && <p className="forward-note is-warning">{t("forward.listenerWarning")}</p>}
          {spec.direction === "remote" && <p className="forward-note">{t("forward.gatewayNote")}</p>}
          {dynamic && <p className="forward-note">{t("forward.dynamicNote")}</p>}
        </div>}
        <button type="submit" className="forward-submit" disabled={!valid || busy}>{t("forward.createTunnel")}</button>
      </form> : <p className="status-popover-note">{t("forward.connectHint")}</p>}
      {eligible && owner && <div className="forward-discovery-section" id={DISCOVERY_ID}>
        <button type="button" className="forward-discovery-toggle" aria-expanded={discoveryOpen} aria-controls={DISCOVERY_ID} onClick={() => setDiscoveryOpen(!discoveryOpen)}>{t("forward.remotePortsToggle")}</button>
        {discoveryOpen && <div className="forward-discovery">
          <div className="forward-discovery-tools">
            {scanning && <span className="forward-discovery-state">{t("forward.readingListeners")}</span>}
            {!scanning && discovery?.status === "ok" && discovery.truncated && <span className="forward-discovery-state">{t("forward.truncated")}</span>}
            <button type="button" disabled={scanning} onClick={() => setRefresh((value) => value + 1)}>{t("forward.refreshPorts")}</button>
          </div>
          {scanError && <div role="alert" className="status-popover-error">{scanError}</div>}
          {discovery?.status === "unsupported" && <p className="status-popover-note">{t("forward.discoveryUnsupported")}</p>}
          {discovery?.status === "ok" && (discovery.ports.length === 0
            ? <p className="status-popover-note">{t("forward.noListeners")}</p>
            : <div className="forward-list forward-listeners">
              <VirtualFileRows entries={discovery.ports.map((port) => ({ ...port, path: `${port.host}:${port.port}` }))} rowHeight={34} resetKey={owner ?? ""}>{(port) => <div className="forward-listener" key={port.path}>
                <span className="forward-listener-address" title={port.process ?? t("forward.processUnavailable")}>
                  <span>{endpoint(port.host, port.port, auto)}</span>
                  {port.process && <span className="forward-listener-process">{port.process}</span>}
                </span>
                <button type="button" title={t("forward.usePortTitle", { port: port.port })} aria-label={t("forward.usePortTitle", { port: port.port })} onClick={() => setSpec({ ...defaults, targetHost: port.host === "::" ? "::1" : ["*", "0.0.0.0"].includes(port.host) ? "127.0.0.1" : port.host, targetPort: port.port })}>{t("forward.use")}</button>
              </div>}</VirtualFileRows>
            </div>)}
        </div>}
      </div>}
      {rows.length > 0 && <div className="forward-list forward-jobs" style={{ "--forward-job-h": `${jobRowHeight}px` } as CSSProperties}>
        <VirtualFileRows entries={rows.map((row) => ({ ...row, path: row.id }))} rowHeight={jobRowHeight} resetKey="tunnels">{(row) => <article className="forward-job" key={row.id}>
          <div className="forward-job-head">
            <span className="forward-job-badge">{t(DIRECTION_BADGE[row.spec.direction])}</span>
            <span className={`forward-job-status is-${row.status}`}><span className="forward-job-dot" aria-hidden="true" />{statusLabel(row.status)}</span>
            <button type="button" className="forward-job-action" disabled={busy || row.status === "stopping"} onClick={() => void perform(() => active(row) ? api.stopPortForward(row.id) : api.removePortForward(row.id))}>{active(row) ? t("forward.stopTunnel") : t("forward.removeTunnel")}</button>
          </div>
          <div className="forward-route">
            <span>{endpoint(row.spec.listenHost, row.spec.listenPort, auto)}</span>
            <span aria-hidden="true">→</span>
            <span>{row.spec.direction === "dynamic" ? t("forward.socksProxy") : endpoint(row.spec.targetHost ?? "", row.spec.targetPort ?? 0, auto)}</span>
          </div>
          <div className="forward-job-footer">
            <span className="forward-job-address" title={row.owner}>{row.address}</span>
            {row.error ? <span className="forward-error" title={row.error}>{row.error}</span> : <span className="forward-job-stats">
              {row.connections > 0 && <span>{row.connections === 1 ? t("forward.connectionOne") : t("forward.connections", { count: row.connections })}</span>}
              {(row.sentBytes > 0 || row.receivedBytes > 0) && <span title={t("forward.trafficTitle")}>↑ {transferBytes(row.sentBytes)} ↓ {transferBytes(row.receivedBytes)}</span>}
            </span>}
          </div>
        </article>}</VirtualFileRows>
      </div>}
    </StatusPopover>}
  </div>;
});
