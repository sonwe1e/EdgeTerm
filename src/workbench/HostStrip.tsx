import { useState } from "react";
import { transferBytes } from "../fileTransfers";
import { useT } from "../useT";
import { formatClock, hostIdentities } from "./model";
import { useHostSampling, useHostSamples } from "./hostSampling";
import { useWorkbench } from "./store";
import type { ServerIdentity } from "./types";

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

  if (hosts.length === 0) return null;
  return (
    <div className="wb-hosts" aria-label={t("wb.hosts")}>
      <span className="wb-hosts-label">{t("wb.hosts")}</span>
      {hosts.map((host) => {
        const sample = samples[host.key];
        const metrics = sample?.metrics;
        const gpu = metrics?.gpuStatus === "ok" ? metrics.gpus[0] : undefined;
        const stale = sample?.at ? Date.now() - sample.at > 20_000 : false;
        return (
          <div className="wb-host" key={host.key}>
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
                CPU {percent(metrics?.cpuPercent)} · RAM{" "}
                {metrics?.memory
                  ? percent((metrics.memory.usedBytes / metrics.memory.totalBytes) * 100)
                  : "—"}{" "}
                · GPU {gpu ? percent(gpu.utilization) : metrics ? metrics.gpuStatus : "—"}
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
                  onClick={() => setOpen(null)}
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
  return (
    <div className="wb-host-detail">
      <strong>{host.server.name || host.server.host}</strong>
      <code>{host.key}</code>
      <span>{t("wb.hostsHint")}</span>
      <dl>
        <dt>{t("wb.cpu")}</dt>
        <dd>
          {percent(metrics?.cpuPercent)} · {metrics?.cpuStatus ?? "—"}
        </dd>
        <dt>{t("wb.memory")}</dt>
        <dd>
          {metrics?.memory
            ? `${transferBytes(metrics.memory.usedBytes)} / ${transferBytes(metrics.memory.totalBytes)}`
            : "—"}
        </dd>
        <dt>{t("wb.disk")}</dt>
        <dd>
          {metrics?.capacity
            ? `${percent((metrics.capacity.usedBytes / metrics.capacity.totalBytes) * 100)} · ${metrics.capacity.mount}`
            : "—"}
        </dd>
        <dt>{t("wb.network")}</dt>
        <dd>
          ↓{metrics?.networkReceiveBps ? transferBytes(Math.round(metrics.networkReceiveBps)) : "—"}/s ·
          ↑{metrics?.networkSendBps ? transferBytes(Math.round(metrics.networkSendBps)) : "—"}/s
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
            : metrics?.gpuStatus ?? "—"}
        </dd>
      </dl>
      <span className="wb-host-time">
        {sample?.at ? t("wb.sampleStale", { time: formatClock(sample.at) }) : t("wb.notChecked")}
      </span>
      {sample?.error && <span className="wb-host-error">{t("wb.sampleFailed", { error: sample.error })}</span>}
    </div>
  );
}
