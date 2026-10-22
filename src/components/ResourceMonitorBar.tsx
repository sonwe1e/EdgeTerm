import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorText } from "../errorInfo";
import type { Translate } from "../i18n";
import * as api from "../api";
import { readMonitorSettings, saveMonitorSettings } from "../monitorSettings";
import { transferBytes } from "../fileTransfers";
import { useStore, type Tab } from "../store";
import { Icon } from "./icons";
import { StatusPopover } from "./StatusPopover";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";
import { Sparkline } from "../workbench/Sparkline";
import {
  peakUtilization,
  pressureOf,
  pushTrend,
  series,
  trendPointFrom,
  type Pressure,
  type TrendPoint,
} from "../workbench/resourceTrend";

const percent = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
const rate = (value: number | null): string => (value === null ? "—" : `${transferBytes(Math.round(value))}/s`);
const usedOf = (used: number | null | undefined, total: number | null | undefined): number | null =>
  used === null || used === undefined || total === null || total === undefined || total <= 0 ? null : (used / total) * 100;

/** The reader-facing name of a sensor state. "ok" states carry no word: the
 *  reading beside it is the answer. */
function stateLabel(t: Translate, status: string): string {
  switch (status) {
    case "denied":
      return t("monitor.stateDenied");
    case "unsupported":
      return t("monitor.stateUnsupported");
    case "error":
      return t("monitor.stateError");
    default:
      return "";
  }
}

/** One quiet line for an accelerator whose sensor could not be read. An absent
 *  device ("unsupported") and an unknown status are both silence: only a real
 *  access or query failure is worth a row. */
function acceleratorNote(t: Translate, label: string, status: string): string | null {
  const state = stateLabel(t, status);
  return state ? `${label} ${state}` : null;
}

/** One tile of the instrument panel: a name, a big reading, its trend and one
 *  quiet line of context (bytes, the other direction, why it is missing). */
function Tile({
  label,
  value,
  tone,
  values,
  max = 100,
  detail,
}: {
  label: ReactNode;
  value: string;
  tone: Pressure;
  values: readonly (number | null)[];
  max?: number;
  detail?: ReactNode;
}) {
  return (
    <div className="monitor-tile">
      <div className="monitor-tile-head">
        <span className="monitor-tile-label">{label}</span>
        <span className={`monitor-tile-value metric-${tone}`}>{value}</span>
      </div>
      <Sparkline
        values={values}
        width={140}
        height={32}
        max={max}
        tone={tone}
        baseline
        className="monitor-spark"
      />
      {detail ? <div className="monitor-tile-detail">{detail}</div> : null}
    </div>
  );
}

interface Device {
  index: number;
  name: string;
  utilization: number | null;
  usedBytes: number | null;
  totalBytes: number | null;
  temperature: number | null;
}

/** One accelerator: identity, its utilization as a bar, the reading, then the
 *  memory and temperature that only a detected device can have. */
function DeviceRow({ kind, device, numbered }: { kind: string; device: Device; numbered: boolean }) {
  const tone = pressureOf(device.utilization, "accelerator");
  const memory =
    device.usedBytes !== null && device.totalBytes !== null
      ? `${transferBytes(device.usedBytes)} / ${transferBytes(device.totalBytes)}`
      : device.usedBytes !== null
        ? transferBytes(device.usedBytes)
        : null;
  const meta = [memory, device.temperature !== null ? `${device.temperature}°C` : null].filter(Boolean).join(" · ");
  const filled = device.utilization === null ? null : Math.max(0, Math.min(100, device.utilization));
  return (
    <div className="monitor-device" title={meta || undefined}>
      <span className="monitor-device-kind">{kind}</span>
      <span className="monitor-device-name">
        {numbered ? `#${device.index} ` : ""}
        {device.name}
      </span>
      <span className={`monitor-device-track is-${tone}`} aria-hidden="true">
        {filled !== null && <span className="monitor-device-fill" style={{ width: `${filled}%` }} />}
      </span>
      <span className={`monitor-device-value metric-${tone}`}>{percent(device.utilization)}</span>
      <span className="monitor-device-meta">{meta}</span>
    </div>
  );
}

/** The tooltip: everything the one-line bar cannot carry, one fact per line. */
function detailTitle(
  t: Translate,
  address: string | undefined,
  sample: api.ResourceMetrics | null,
  error: string | null,
): string {
  const lines: string[] = [];
  if (address) lines.push(address);
  if (sample?.status === "ok") {
    lines.push(
      `${t("monitor.cpu")} ${percent(sample.cpuPercent)} · ${t("monitor.ram")} ${percent(
        usedOf(sample.memory?.usedBytes, sample.memory?.totalBytes),
      )}`,
    );
    lines.push(
      `${t("monitor.diskCapacity")} ${percent(usedOf(sample.capacity?.usedBytes, sample.capacity?.totalBytes))} · ${t(
        "monitor.diskIo",
      )} ${t("monitor.read")} ${rate(sample.diskReadBps)} ${t("monitor.write")} ${rate(sample.diskWriteBps)}`,
    );
    lines.push(`${t("monitor.network")} ↓${rate(sample.networkReceiveBps)} ↑${rate(sample.networkSendBps)}`);
    if (sample.gpuStatus === "ok") {
      for (const gpu of sample.gpus) lines.push(`${t("monitor.gpu")} #${gpu.index} ${gpu.name} ${percent(gpu.utilization)}`);
    }
    if (sample.npuStatus === "ok") {
      for (const npu of sample.npus) lines.push(`${t("monitor.npu")} #${npu.index} ${npu.name} ${percent(npu.utilization)}`);
    }
  } else if (sample?.status === "unsupported") {
    lines.push(t("monitor.resourcesUnsupported"));
  }
  if (error) lines.push(t("monitor.stale", { error }));
  return lines.join("\n");
}

/**
 * The SSH host monitor in the status bar: one compact vitals cluster (CPU, RAM,
 * and whatever accelerator was detected) whose full detail lives in the title,
 * plus a quiet instrument panel in the popover. Every number comes from a live
 * sample; a sensor that cannot be read says so instead of showing a zero.
 */
export const ResourceMonitorBar = memo(function ResourceMonitorBar({ tab }: { tab: Tab | undefined }) {
  const t = useT();
  const revision = useStore((state) => state.panelPreferencesRevision);
  const [settings, setSettings] = useState(readMonitorSettings);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [sample, setSample] = useState<api.ResourceMetrics | null>(null);
  // A bounded trend window: the last few dozen compacted samples, so the
  // sparklines can draw a curve instead of only the instantaneous value.
  const [history, setHistory] = useState<TrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), container);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<string | null>(null);
  const id = tab?.info.id;
  const eligible = tab?.state === "connected" && (tab.info.kind === "ssh" || tab.info.kind === "sftp");
  useEffect(() => setSettings(readMonitorSettings()), [revision]);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => setOpen(false), [id]);
  useEffect(() => {
    setSample(null);
    setError(null);
    setHistory([]);
    if (!id || !eligible || !visible || !settings.enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const requestId = crypto.randomUUID();
      pending.current = requestId;
      const started = performance.now();
      let unsupported = false;
      try {
        const found = await api.sampleResources(id, requestId);
        if (!stopped && pending.current === requestId) {
          setSample(found);
          setError(null);
          unsupported = found.status === "unsupported";
          setHistory((previous) => pushTrend(previous, trendPointFrom(found, Date.now())));
        }
      } catch (e) {
        if (!stopped && pending.current === requestId) setError(errorText(e));
      } finally {
        if (pending.current === requestId) pending.current = null;
        if (!stopped && !unsupported)
          timer = setTimeout(poll, Math.max(100, settings.intervalSeconds * 1000 - (performance.now() - started)));
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      const requestId = pending.current;
      pending.current = null;
      if (requestId) void api.cancelResourceSample(requestId).catch(() => {});
    };
  }, [id, eligible, visible, settings.enabled, settings.intervalSeconds, attempt]);
  // Series are derived from the bounded history, so their array identity only
  // changes when a new sample arrives — not on every unrelated re-render. That
  // keeps the memoised Sparkline from redrawing between polls.
  const cpuSeries = useMemo(() => series(history, "cpu"), [history]);
  const memSeries = useMemo(() => series(history, "memory"), [history]);
  const diskSeries = useMemo(() => series(history, "disk"), [history]);
  const netSeries = useMemo(() => series(history, "net"), [history]);
  const gpuSeries = useMemo(() => series(history, "gpu"), [history]);
  const npuSeries = useMemo(() => series(history, "npu"), [history]);
  if (!eligible) return null;
  const update = (value: typeof settings) => {
    setSettings(value);
    saveMonitorSettings(value);
  };
  const memory = sample?.memory;
  const capacity = sample?.capacity;
  const memPercent = usedOf(memory?.usedBytes, memory?.totalBytes);
  const diskPercent = usedOf(capacity?.usedBytes, capacity?.totalBytes);
  const cpuTone = pressureOf(sample?.cpuPercent ?? null, "cpu");
  const memTone = pressureOf(memPercent, "memory");
  const diskTone = pressureOf(diskPercent, "disk");
  const gpus: api.ResourceMetrics["gpus"] = sample && sample.gpuStatus === "ok" ? sample.gpus : [];
  const npus: api.ResourceMetrics["npus"] = sample && sample.npuStatus === "ok" ? sample.npus : [];
  const gpuPeak = peakUtilization(gpus);
  const npuPeak = peakUtilization(npus);
  const gpuTone = pressureOf(gpuPeak, "accelerator");
  const npuTone = pressureOf(npuPeak, "accelerator");
  // An accelerator that is merely absent says nothing; one the host cannot read
  // or query says so in one quiet line, so a root-only NPU is not silently
  // missing from the panel. An older backend sends no accelerator fields at
  // all — that is absence, not an error, so it stays quiet too.
  const acceleratorNotes: string[] = sample
    ? [acceleratorNote(t, t("monitor.gpu"), sample.gpuStatus), acceleratorNote(t, t("monitor.npu"), sample.npuStatus)].filter(
        (note): note is string => note !== null,
      )
    : [];
  // The network sparkline is scaled to its own recent peak (a floor of 1 B/s so
  // an idle link is a flat line, not a divide-by-zero); it has no "too full"
  // threshold, so it stays in the calm tone.
  const netMax = Math.max(1, ...netSeries.filter((value): value is number => value !== null));
  const vitals =
    sample?.status === "ok"
      ? [
          { key: "cpu", label: t("monitor.cpu"), value: percent(sample.cpuPercent), tone: cpuTone, values: cpuSeries },
          { key: "ram", label: t("monitor.ram"), value: percent(memPercent), tone: memTone, values: memSeries },
          ...(gpus.length > 0
            ? [{ key: "gpu", label: t("monitor.gpu"), value: percent(gpuPeak), tone: gpuTone, values: gpuSeries }]
            : []),
          ...(npus.length > 0
            ? [{ key: "npu", label: t("monitor.npu"), value: percent(npuPeak), tone: npuTone, values: npuSeries }]
            : []),
        ]
      : [];
  // The plain state a bar falls back to when there is nothing to plot: off,
  // an unsupported host, a failed read, or the first round trip.
  const plain = !settings.enabled
    ? t("monitor.resourcesOff")
    : sample?.status === "unsupported"
      ? t("monitor.resourcesUnsupported")
      : error
        ? t("monitor.resourcesUnavailable")
        : sample
          ? t("monitor.resources")
          : t("monitor.readingResources");
  const compact =
    vitals.length > 0
      ? `${t("monitor.cpu")} ${percent(sample?.cpuPercent ?? null)} · ${t("monitor.ram")} ${percent(memPercent)}`
      : plain;
  // The cluster's visible text runs together (label, sparkline, reading), so the
  // button's accessible name is the same facts said as a list.
  const summaryLabel =
    vitals.length > 0 ? vitals.map((vital) => `${vital.label} ${vital.value}`).join(", ") : plain;
  return (
    <div className="resource-monitor" ref={container}>
      <button
        type="button"
        className={`status-item resource-summary${error ? " is-stale" : ""}`}
        title={detailTitle(t, tab?.info.address, sample, error)}
        aria-label={summaryLabel}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {/* The shared status-item rule makes this button a flex container, so
            the responsive pair lives inside one block child: a flex item
            would blockify the wide/cluster spans and the display-based
            breakpoint could not switch them. */}
        <span className="resource-summary-line">
          <span className="resource-wide">
            {vitals.length > 0 ? (
              <span className="resource-vitals">
                {vitals.map((vital) => (
                  <span className="vital" key={vital.key}>
                    <span className="vital-label">{vital.label}</span>
                    <Sparkline
                      values={vital.values}
                      width={30}
                      height={12}
                      max={100}
                      tone={vital.tone}
                      className="spark-mini"
                    />
                    <span className={`vital-value metric-${vital.tone}`}>{vital.value}</span>
                  </span>
                ))}
              </span>
            ) : (
              plain
            )}
          </span>
          <span className="resource-compact">{compact}</span>
        </span>
      </button>
      {open && (
        <StatusPopover
          label={t("monitor.sshHostResources")}
          title={tab?.info.address ?? ""}
          closeLabel={t("monitor.closeResources")}
          onClose={() => setOpen(false)}
          className="monitor-popover"
          actions={
            <button
              type="button"
              className="monitor-refresh"
              aria-label={t("monitor.refreshResources")}
              title={t("monitor.refreshResources")}
              disabled={!settings.enabled}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <Icon name="refresh" />
            </button>
          }
        >
          {error && (
            <p className="status-popover-error" role="alert">
              {t("monitor.staleUnavailable", { error })}
            </p>
          )}
          {sample?.status === "unsupported" && <p className="status-popover-note">{t("monitor.samplingLinux")}</p>}
          {sample?.status === "ok" && (
            <>
              <div className="monitor-grid">
                <Tile
                  label={t("monitor.cpu")}
                  value={percent(sample.cpuPercent)}
                  tone={cpuTone}
                  values={cpuSeries}
                  detail={stateLabel(t, sample.cpuStatus)}
                />
                <Tile
                  label={t("monitor.ram")}
                  value={percent(memPercent)}
                  tone={memTone}
                  values={memSeries}
                  detail={
                    memory
                      ? `${transferBytes(memory.usedBytes)} / ${transferBytes(memory.totalBytes)}`
                      : stateLabel(t, sample.memoryStatus)
                  }
                />
                <Tile
                  label={capacity?.mount ? `${t("monitor.diskCapacity")} ${capacity.mount}` : t("monitor.diskCapacity")}
                  value={percent(diskPercent)}
                  tone={diskTone}
                  values={diskSeries}
                  detail={
                    capacity
                      ? `${transferBytes(capacity.usedBytes)} / ${transferBytes(capacity.totalBytes)}`
                      : stateLabel(t, sample.capacityStatus)
                  }
                />
                <Tile
                  label={t("monitor.network")}
                  value={sample.networkReceiveBps === null ? "—" : `↓${rate(sample.networkReceiveBps)}`}
                  tone="ok"
                  values={netSeries}
                  max={netMax}
                  detail={
                    sample.networkReceiveBps === null && sample.networkSendBps === null
                      ? stateLabel(t, sample.networkStatus) || "—"
                      : sample.networkSendBps === null
                        ? stateLabel(t, sample.networkStatus)
                        : `↑${rate(sample.networkSendBps)}`
                  }
                />
              </div>
              <div className="monitor-io">
                <span className="monitor-io-label">{t("monitor.diskIo")}</span>
                {sample.diskReadBps === null && sample.diskWriteBps === null
                  ? stateLabel(t, sample.diskStatus) || "—"
                  : `${t("monitor.read")} ${rate(sample.diskReadBps)} · ${t("monitor.write")} ${rate(sample.diskWriteBps)}`}
              </div>
              {acceleratorNotes.length > 0 && <div className="monitor-io">{acceleratorNotes.join(" · ")}</div>}
              {(gpus.length > 0 || npus.length > 0) && (
                <div className="monitor-devices" role="group" aria-label={t("monitor.devices")}>
                  {gpus.map((gpu) => (
                    <DeviceRow key={`gpu-${gpu.index}`} kind={t("monitor.gpu")} device={gpu} numbered={gpus.length > 1} />
                  ))}
                  {npus.map((npu) => (
                    <DeviceRow key={`npu-${npu.index}`} kind={t("monitor.npu")} device={npu} numbered={npus.length > 1} />
                  ))}
                </div>
              )}
            </>
          )}
          <div className="monitor-controls">
            <label className="monitor-toggle">
              <input
                type="checkbox"
                aria-label={t("monitor.monitorCurrentHost")}
                checked={settings.enabled}
                onChange={(event) => update({ ...settings, enabled: event.target.checked })}
              />
              {t("monitor.monitorCurrentHost")}
            </label>
            <label className="monitor-interval">
              {t("monitor.sampleEvery")}
              <input
                type="number"
                aria-label={t("monitor.sampleIntervalAria")}
                min={1}
                max={30}
                value={settings.intervalSeconds}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 30) update({ ...settings, intervalSeconds: value });
                }}
              />
              s
            </label>
          </div>
        </StatusPopover>
      )}
    </div>
  );
});
