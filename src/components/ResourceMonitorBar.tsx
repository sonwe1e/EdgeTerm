import { memo, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { readMonitorSettings, saveMonitorSettings } from "../monitorSettings";
import { transferBytes } from "../fileTransfers";
import { useStore, type Tab } from "../store";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { useT } from "../useT";
import { Sparkline } from "../workbench/Sparkline";
import { pressureOf, pushTrend, series, trendPointFrom, type TrendPoint } from "../workbench/resourceTrend";

const percent = (value:number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const rate = (value:number | null) => value === null ? "—" : `${transferBytes(Math.round(value))}/s`;
export const ResourceMonitorBar = memo(function ResourceMonitorBar({tab}:{tab:Tab | undefined}) {
  const t = useT();
  const revision = useStore((state) => state.panelPreferencesRevision);
  const [settings,setSettings] = useState(readMonitorSettings);
  const [visible,setVisible] = useState(() => !document.hidden);
  const [sample,setSample] = useState<api.ResourceMetrics | null>(null);
  // A bounded trend window: the last few dozen compacted samples, so the
  // popover can draw a sparkline instead of only the instantaneous value.
  const [history,setHistory] = useState<TrendPoint[]>([]);
  const [error,setError] = useState<string | null>(null);
  const [open,setOpen] = useState(false);
  const container=useRef<HTMLDivElement>(null);
  usePopoverDismiss(open,()=>setOpen(false),container);
  const [attempt,setAttempt] = useState(0);
  const [gpuIndex,setGpuIndex] = useState(0);
  const pending = useRef<string | null>(null);
  const id = tab?.info.id;
  const eligible = tab?.state === "connected" && (tab.info.kind === "ssh" || tab.info.kind === "sftp");
  useEffect(() => setSettings(readMonitorSettings()),[revision]);
  useEffect(() => { const update=()=>setVisible(!document.hidden);document.addEventListener("visibilitychange",update);return()=>document.removeEventListener("visibilitychange",update); },[]);
  useEffect(() => {setGpuIndex(0);setOpen(false);},[id]);
  useEffect(() => {
    setSample(null);setError(null);setHistory([]);
    if (!id || !eligible || !visible || !settings.enabled) return;
    let stopped=false;let timer:ReturnType<typeof setTimeout> | undefined;
    const poll=async()=>{
      const requestId=crypto.randomUUID();pending.current=requestId;const started=performance.now();let unsupported=false;
      try {
        const found=await api.sampleResources(id,requestId);
        if (!stopped && pending.current===requestId) {setSample(found);setError(null);unsupported=found.status==="unsupported";setHistory((previous)=>pushTrend(previous,trendPointFrom(found,Date.now())));}
      } catch(e) {if(!stopped && pending.current===requestId)setError(errorText(e));}
      finally {
        if(pending.current===requestId)pending.current=null;
        if(!stopped && !unsupported)timer=setTimeout(poll,Math.max(100,settings.intervalSeconds*1000-(performance.now()-started)));
      }
    };
    void poll();
    return()=>{stopped=true;clearTimeout(timer);const requestId=pending.current;pending.current=null;if(requestId)void api.cancelResourceSample(requestId).catch(()=>{});};
  },[id,eligible,visible,settings.enabled,settings.intervalSeconds,attempt]);
  // Series are derived from the bounded history, so their array identity only
  // changes when a new sample arrives — not on every unrelated re-render. That
  // keeps the memoised Sparkline from redrawing between polls.
  const cpuSeries=useMemo(()=>series(history,"cpu"),[history]);
  const memSeries=useMemo(()=>series(history,"memory"),[history]);
  const netSeries=useMemo(()=>series(history,"net"),[history]);
  if (!eligible) return null;
  const update=(value:typeof settings)=>{setSettings(value);saveMonitorSettings(value);};
  const memory=sample?.memory;const capacity=sample?.capacity;
  const memPercent=memory && memory.totalBytes>0 ? memory.usedBytes/memory.totalBytes*100 : null;
  const diskPercent=capacity && capacity.totalBytes>0 ? capacity.usedBytes/capacity.totalBytes*100 : null;
  const cpuTone=pressureOf(sample?.cpuPercent ?? null,"cpu");
  const memTone=pressureOf(memPercent,"memory");
  const diskTone=pressureOf(diskPercent,"disk");
  // The network sparkline is scaled to its own recent peak (a floor of 1 B/s so
  // an idle link is a flat line, not a divide-by-zero); it has no "too full"
  // threshold, so it stays in the calm tone.
  const netMax=Math.max(1,...netSeries.filter((value):value is number=>value!==null));
  const gpu=sample?.gpuStatus==="ok" ? sample.gpus.find((value)=>value.index===gpuIndex) ?? sample.gpus[0] : undefined;
  const summary= !settings.enabled ? t("monitor.resourcesOff") : sample?.status==="unsupported" ? t("monitor.resourcesUnsupported") : sample ?
    `CPU ${percent(sample.cpuPercent)} · RAM ${memory ? percent(memory.usedBytes/memory.totalBytes*100) : "—"} · Disk ${capacity ? percent(capacity.usedBytes/capacity.totalBytes*100) : "—"} · Net ↓${rate(sample.networkReceiveBps)} ↑${rate(sample.networkSendBps)} · GPU ${gpu ? percent(gpu.utilization) : sample.gpuStatus}` : error ? t("monitor.resourcesUnavailable") : t("monitor.readingResources");
  return <div className="resource-monitor" ref={container}>
    <button type="button" className={`status-item resource-summary${error?" is-stale":""}`} title={`${tab?.info.address} · ${summary}${error ? t("monitor.stale", { error }) : ""}`} aria-expanded={open} onClick={()=>setOpen(!open)}>
      <span className="resource-wide">{summary}</span><span className="resource-compact">{t("monitor.resources")}{sample?.cpuPercent != null ? t("monitor.cpuCompact", { value: percent(sample.cpuPercent) }) : ""}{error ? t("monitor.staleCompact") : ""}</span>
    </button>
    {open && <section className="resource-popover" aria-label={t("monitor.sshHostResources")}>
      <div className="resource-heading"><strong>{tab?.info.address}</strong><button type="button" aria-label={t("monitor.closeResources")} onClick={()=>setOpen(false)}>×</button></div>
      <label><input type="checkbox" aria-label={t("monitor.monitorCurrentHost")} checked={settings.enabled} onChange={(event)=>update({...settings,enabled:event.target.checked})} /> {t("monitor.monitorCurrentHost")}</label>
      <label>{t("monitor.sampleEvery")} <input type="number" aria-label={t("monitor.sampleIntervalAria")} min={1} max={30} value={settings.intervalSeconds} onChange={(event)=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=30)update({...settings,intervalSeconds:value});}} /> s</label>
      <button type="button" disabled={!settings.enabled} onClick={()=>setAttempt((value)=>value+1)}>{t("monitor.refreshResources")}</button>
      {error && <div role="alert">{t("monitor.staleUnavailable", { error })}</div>}
      {sample?.status==="unsupported" && <p>{t("monitor.samplingLinux")}</p>}
      {sample && <dl>
        <dt>CPU</dt><dd><span className={`metric-${cpuTone}`}>{percent(sample.cpuPercent)}</span> · {sample.cpuStatus}{sample.cpuPercent===null && sample.cpuStatus==="ok" ? t("monitor.waitingSample") : ""}<Sparkline values={cpuSeries} tone={cpuTone} /></dd>
        <dt>{t("monitor.memory")}</dt><dd>{memory ? <><span className={`metric-${memTone}`}>{percent(memPercent)}</span> · {`${transferBytes(memory.usedBytes)} / ${transferBytes(memory.totalBytes)}`}</> : sample.memoryStatus}<Sparkline values={memSeries} tone={memTone} /></dd>
        <dt>{t("monitor.diskCapacity")} {capacity?.mount}</dt><dd>{capacity ? <><span className={`metric-${diskTone}`}>{percent(diskPercent)}</span> · {`${transferBytes(capacity.usedBytes)} / ${transferBytes(capacity.totalBytes)}`}</> : sample.capacityStatus}</dd>
        <dt>{t("monitor.diskIo")}</dt><dd>{t("monitor.read")} {rate(sample.diskReadBps)} · {t("monitor.write")} {rate(sample.diskWriteBps)} · {sample.diskStatus}</dd>
        <dt>{t("monitor.network")}</dt><dd>{t("monitor.receive")} {rate(sample.networkReceiveBps)} · {t("monitor.send")} {rate(sample.networkSendBps)} · {sample.networkStatus}<Sparkline values={netSeries} tone="ok" max={netMax} /></dd>
        <dt>GPU</dt><dd>{sample.gpuStatus}
          {sample.gpus.length>1 && <select aria-label={t("monitor.gpuDevice")} value={gpu?.index ?? ""} onChange={(event)=>setGpuIndex(Number(event.target.value))}>{sample.gpus.map((value)=><option key={value.index} value={value.index}>{value.index}: {value.name}</option>)}</select>}
          {gpu && <><div>{gpu.name} · {percent(gpu.utilization)}</div><div>{gpu.usedBytes===null||gpu.totalBytes===null ? t("monitor.vramUnavailable") : `${transferBytes(gpu.usedBytes)} / ${transferBytes(gpu.totalBytes)}`}{gpu.temperature!==null && ` · ${gpu.temperature}°C`}</div></>}
        </dd>
      </dl>}
      <p>{t("monitor.detailNote")}</p>
    </section>}
  </div>;
});
