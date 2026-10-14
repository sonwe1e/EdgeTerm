import { memo, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { readMonitorSettings, saveMonitorSettings } from "../monitorSettings";
import { transferBytes } from "../fileTransfers";
import { useStore, type Tab } from "../store";
import { usePopoverDismiss } from "./usePopoverDismiss";

const percent = (value:number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const rate = (value:number | null) => value === null ? "—" : `${transferBytes(Math.round(value))}/s`;
export const ResourceMonitorBar = memo(function ResourceMonitorBar({tab}:{tab:Tab | undefined}) {
  const revision = useStore((state) => state.panelPreferencesRevision);
  const [settings,setSettings] = useState(readMonitorSettings);
  const [visible,setVisible] = useState(() => !document.hidden);
  const [sample,setSample] = useState<api.ResourceMetrics | null>(null);
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
    setSample(null);setError(null);
    if (!id || !eligible || !visible || !settings.enabled) return;
    let stopped=false;let timer:ReturnType<typeof setTimeout> | undefined;
    const poll=async()=>{
      const requestId=crypto.randomUUID();pending.current=requestId;const started=performance.now();let unsupported=false;
      try {
        const found=await api.sampleResources(id,requestId);
        if (!stopped && pending.current===requestId) {setSample(found);setError(null);unsupported=found.status==="unsupported";}
      } catch(e) {if(!stopped && pending.current===requestId)setError(String(e));}
      finally {
        if(pending.current===requestId)pending.current=null;
        if(!stopped && !unsupported)timer=setTimeout(poll,Math.max(100,settings.intervalSeconds*1000-(performance.now()-started)));
      }
    };
    void poll();
    return()=>{stopped=true;clearTimeout(timer);const requestId=pending.current;pending.current=null;if(requestId)void api.cancelResourceSample(requestId).catch(()=>{});};
  },[id,eligible,visible,settings.enabled,settings.intervalSeconds,attempt]);
  if (!eligible) return null;
  const update=(value:typeof settings)=>{setSettings(value);saveMonitorSettings(value);};
  const memory=sample?.memory;const capacity=sample?.capacity;
  const gpu=sample?.gpuStatus==="ok" ? sample.gpus.find((value)=>value.index===gpuIndex) ?? sample.gpus[0] : undefined;
  const summary= !settings.enabled ? "Resources off" : sample?.status==="unsupported" ? "Resources unsupported" : sample ?
    `CPU ${percent(sample.cpuPercent)} · RAM ${memory ? percent(memory.usedBytes/memory.totalBytes*100) : "—"} · Disk ${capacity ? percent(capacity.usedBytes/capacity.totalBytes*100) : "—"} · Net ↓${rate(sample.networkReceiveBps)} ↑${rate(sample.networkSendBps)} · GPU ${gpu ? percent(gpu.utilization) : sample.gpuStatus}` : error ? "Resources unavailable" : "Reading resources…";
  return <div className="resource-monitor" ref={container}>
    <button type="button" className={`status-item resource-summary${error?" is-stale":""}`} title={`${tab?.info.address} · ${summary}${error ? ` · stale: ${error}` : ""}`} aria-expanded={open} onClick={()=>setOpen(!open)}>
      <span className="resource-wide">{summary}</span><span className="resource-compact">Resources{sample?.cpuPercent != null ? ` · CPU ${percent(sample.cpuPercent)}` : ""}{error ? " · stale" : ""}</span>
    </button>
    {open && <section className="resource-popover" aria-label="SSH host resources">
      <div className="resource-heading"><strong>{tab?.info.address}</strong><button type="button" aria-label="Close resources" onClick={()=>setOpen(false)}>×</button></div>
      <label><input type="checkbox" aria-label="Monitor current SSH host" checked={settings.enabled} onChange={(event)=>update({...settings,enabled:event.target.checked})} /> Monitor current SSH host</label>
      <label>Sample every <input type="number" aria-label="Resource sample interval in seconds" min={1} max={30} value={settings.intervalSeconds} onChange={(event)=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=30)update({...settings,intervalSeconds:value});}} /> s</label>
      <button type="button" disabled={!settings.enabled} onClick={()=>setAttempt((value)=>value+1)}>Refresh resources</button>
      {error && <div role="alert">Stale / unavailable: {error}</div>}
      {sample?.status==="unsupported" && <p>Resource sampling currently supports Linux SSH hosts.</p>}
      {sample && <dl>
        <dt>CPU</dt><dd>{percent(sample.cpuPercent)} · {sample.cpuStatus}{sample.cpuPercent===null && sample.cpuStatus==="ok" ? " · waiting for another sample" : ""}</dd>
        <dt>Memory</dt><dd>{memory ? `${transferBytes(memory.usedBytes)} / ${transferBytes(memory.totalBytes)}` : sample.memoryStatus}</dd>
        <dt>Disk capacity {capacity?.mount}</dt><dd>{capacity ? `${transferBytes(capacity.usedBytes)} / ${transferBytes(capacity.totalBytes)}` : sample.capacityStatus}</dd>
        <dt>Disk I/O</dt><dd>Read {rate(sample.diskReadBps)} · Write {rate(sample.diskWriteBps)} · {sample.diskStatus}</dd>
        <dt>Network</dt><dd>Receive {rate(sample.networkReceiveBps)} · Send {rate(sample.networkSendBps)} · {sample.networkStatus}</dd>
        <dt>GPU</dt><dd>{sample.gpuStatus}
          {sample.gpus.length>1 && <select aria-label="GPU device" value={gpu?.index ?? ""} onChange={(event)=>setGpuIndex(Number(event.target.value))}>{sample.gpus.map((value)=><option key={value.index} value={value.index}>{value.index}: {value.name}</option>)}</select>}
          {gpu && <><div>{gpu.name} · {percent(gpu.utilization)}</div><div>{gpu.usedBytes===null||gpu.totalBytes===null ? "VRAM unavailable" : `${transferBytes(gpu.usedBytes)} / ${transferBytes(gpu.totalBytes)}`}{gpu.temperature!==null && ` · ${gpu.temperature}°C`}</div></>}
        </dd>
      </dl>}
      <p>Rates need two samples. Disk capacity is for the root filesystem; disk I/O covers whole devices without partitions or device-mapper duplicates. Network uses physical interfaces when exposed, otherwise non-loopback interfaces. GPU queries currently cover NVIDIA.</p>
    </section>}
  </div>;
});
