import { useMemo, useRef, useState } from "react";
import { usePopoverDismiss } from "../components/usePopoverDismiss";
import { transferBytes } from "../fileTransfers";
import { useT } from "../useT";
import { formatClock, hostIdentities } from "./model";
import { useHostSampling, useHostSamples } from "./hostSampling";
import { Sparkline } from "./Sparkline";
import { pressureOf, series, type TrendPoint } from "./resourceTrend";
import { useWorkbench } from "./store";
import type { ServerIdentity } from "./types";

// A stable empty window so the detail's memoised series keep a fixed identity
// before the first sample lands.
const NO_HISTORY: TrendPoint[] = [];

const percent = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${value.toFixed(0)}%`;

/**
 * One chip per server, fed by one sampler per server. Several projects on the
 * same login share the chip and the sampling work; the popover says when the
 * numbers were read, and a failed read leaves the previous numbers marked as
 * stale rather than pretending they are current.
 */
export function HostStrip() {
  const t = useT();
  const workspaces = useWorkbench((state) => state.data.workspaces);
  const hosts = hostIdentities(workspaces);
  useHostSampling(hosts);
  const samples = useHostSamples((state) => state.samples);
  const [open, setOpen] = useState<string | null>(null);
  // Scope dismissal and focus return to the expanded host, not the strip's
  // first host. Clicking another host still opens that host in one gesture.
  const openRoot = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open !== null, () => setOpen(null), openRoot);

  if (hosts.length === 0) return null;
  return (
    <div className={`wb-hosts${hosts.length > 1 ? " is-multi" : ""}`} aria-label={t("wb.hosts")}>
      <span className="wb-hosts-label">{t("wb.hosts")}</span>
      {hosts.map((host) => {
        const sample = samples[host.key];
        const metrics = sample?.metrics;
        const gpu = metrics?.gpuStatus === "ok" ? metrics.gpus[0] : undefined;
        const stale = sample?.at ? Date.now() - sample.at > 20_000 : false;
        const memPercent =
          metrics?.memory && metrics.memory.totalBytes > 0
            ? (metrics.memory.usedBytes / metrics.memory.totalBytes) * 100
            : null;
        const cpuTone = pressureOf(metrics?.cpuPercent ?? null, "cpu");
        const memTone = pressureOf(memPercent, "memory");
        return (
          <div className="wb-host" key={host.key} ref={open === host.key ? openRoot : undefined}>
            <button
              type="button"
              className={`wb-host-chip${sample?.error ? " is-error" : ""}${stale ? " is-stale" : ""}`}
              title={`${host.key}${sample?.error ? ` · ${sample.error}` : ""}`}
              aria-expanded={open === host.key}
              onClick={() => setOpen(open === host.key ? null : host.key)}
            >
              <span className="wb-host-name">{host.server.name || host.server.host}</span>
              <span className="wb-host-user">{host.key}</span>
              <span className="wb-host-metrics">
                CPU <span className={`metric-${cpuTone}`}>{percent(metrics?.cpuPercent)}</span>
                {" · RAM"} <span className={`metric-${memTone}`}>{percent(memPercent)}</span>{" "}
                {"· GPU "}
                {gpu ? percent(gpu.utilization) : metrics ? metrics.gpuStatus : "—"}
              </span>
              {host.workspaceIds.length > 1 && (
                <span className="wb-host-shared">{host.workspaceIds.length}</span>
              )}
            </button>
            {open === host.key && (
              <div className="wb-host-popover" role="dialog" aria-label={host.key}>
                <HostDetail host={host} sample={sample} />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    openRoot.current?.querySelector("button")?.focus({ preventScroll: true });
                    setOpen(null);
                  }}
                >
                  {t("common.close")}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HostDetail({
  host,
  sample,
}: {
  host: ServerIdentity;
  sample: ReturnType<typeof useHostSamples.getState>["samples"][string] | undefined;
}) {
  const t = useT();
  const metrics = sample?.metrics;
  const cpuSeries = useMemo(() => series(sample?.history ?? NO_HISTORY, "cpu"), [sample?.history]);
  const memSeries = useMemo(
    () => series(sample?.history ?? NO_HISTORY, "memory"),
    [sample?.history],
  );
  const memPercent =
    metrics?.memory && metrics.memory.totalBytes > 0
      ? (metrics.memory.usedBytes / metrics.memory.totalBytes) * 100
      : null;
  const cpuTone = pressureOf(metrics?.cpuPercent ?? null, "cpu");
  const memTone = pressureOf(memPercent, "memory");
  return (
    <div className="wb-host-detail">
      <strong>{host.server.name || host.server.host}</strong>
      <code>{host.key}</code>
      <span>{t("wb.hostsHint")}</span>
      <dl>
        <dt>{t("wb.cpu")}</dt>
        <dd>
          <span className={`metric-${cpuTone}`}>{percent(metrics?.cpuPercent)}</span>
          {" · "}
          {metrics?.cpuStatus ?? "—"}
          <Sparkline values={cpuSeries} tone={cpuTone} />
        </dd>
        <dt>{t("wb.memory")}</dt>
        <dd>
          {metrics?.memory ? (
            <>
              <span className={`metric-${memTone}`}>{percent(memPercent)}</span> ·{" "}
              {`${transferBytes(metrics.memory.usedBytes)} / ${transferBytes(metrics.memory.totalBytes)}`}
            </>
          ) : (
            "—"
          )}
          <Sparkline values={memSeries} tone={memTone} />
        </dd>
        <dt>{t("wb.disk")}</dt>
        <dd>
          {metrics?.capacity
            ? `${percent((metrics.capacity.usedBytes / metrics.capacity.totalBytes) * 100)} · ${metrics.capacity.mount}`
            : "—"}
        </dd>
        <dt>{t("wb.network")}</dt>
        <dd>
          ↓
          {metrics?.networkReceiveBps != null
            ? transferBytes(Math.round(metrics.networkReceiveBps))
            : "—"}
          /s · ↑
          {metrics?.networkSendBps != null
            ? transferBytes(Math.round(metrics.networkSendBps))
            : "—"}
          /s
        </dd>
        <dt>{t("wb.gpu")}</dt>
        <dd>
          {metrics && metrics.gpus.length > 0
            ? metrics.gpus
                .map(
                  (gpu) =>
                    `${gpu.index}: ${gpu.name} ${percent(gpu.utilization)}${
                      gpu.usedBytes && gpu.totalBytes
                        ? ` · ${transferBytes(gpu.usedBytes)} / ${transferBytes(gpu.totalBytes)}`
                        : ""
                    }`,
                )
                .join(" · ")
            : (metrics?.gpuStatus ?? "—")}
        </dd>
      </dl>
      <span className="wb-host-time">
        {sample?.at ? t("wb.sampleStale", { time: formatClock(sample.at) }) : t("wb.notChecked")}
      </span>
      {sample?.error && (
        <span className="wb-host-error">{t("wb.sampleFailed", { error: sample.error })}</span>
      )}
    </div>
  );
}
