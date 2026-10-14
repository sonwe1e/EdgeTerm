import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api=vi.hoisted(()=>({sampleResources:vi.fn(),cancelResourceSample:vi.fn()}));
vi.mock("../api",()=>api);
vi.mock("../platform",()=>({IS_MAC:false,IS_WINDOWS:true}));
import { ResourceMonitorBar } from "./ResourceMonitorBar";
import { useStore,type Tab } from "../store";
import type { ResourceMetrics } from "../api";
const metrics:ResourceMetrics={status:"ok",cpuPercent:null,cpuStatus:"ok",memory:{usedBytes:1024,totalBytes:4096},memoryStatus:"ok",capacity:{usedBytes:1024,totalBytes:8192,mount:"/"},capacityStatus:"ok",diskReadBps:null,diskWriteBps:null,diskStatus:"ok",networkReceiveBps:null,networkSendBps:null,networkStatus:"ok",gpus:[],gpuStatus:"unsupported"};
const tab=(id="ssh"):Tab=>({info:{id,kind:"ssh",address:id},state:"connected"} as Tab);
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;vi.clearAllMocks();localStorage.clear();api.sampleResources.mockResolvedValue(metrics);api.cancelResourceSample.mockResolvedValue(undefined);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it("monitors only SSH and exposes units, first-sample unknown and mounted import/reset",async()=>{
  const host=document.createElement("div");const root=createRoot(host);
  try {
    await act(async()=>root.render(h(ResourceMonitorBar,{tab:{...tab(),info:{...tab().info,kind:"local"}}})));
    expect(api.sampleResources).not.toHaveBeenCalled();
    await act(async()=>root.render(h(ResourceMonitorBar,{tab:tab()})));
    expect(api.sampleResources).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("CPU —");
    await act(async()=>host.querySelector("button")!.click());
    expect(host.textContent).toContain("Disk capacity /");expect(host.textContent).toContain("Disk I/O");expect(host.textContent).toContain("unsupported");
    const interval=()=>host.querySelector<HTMLInputElement>('[aria-label="Resource sample interval in seconds"]')!;
    await act(async()=>useStore.getState().applySettings({preferences:{"edgeterm.resource-monitor":{enabled:false,intervalSeconds:7}}}));
    expect(interval().value).toBe("7");expect(host.querySelector<HTMLInputElement>('[aria-label="Monitor current SSH host"]')!.checked).toBe(false);
    await act(async()=>useStore.getState().resetSettings());expect(interval().value).toBe("2");expect(host.querySelector<HTMLInputElement>('[aria-label="Monitor current SSH host"]')!.checked).toBe(true);
  }finally{act(()=>root.unmount());}
});
it("keeps one in-flight sample and cancels switched or hidden hosts without stale repaint",async()=>{
  vi.useFakeTimers();let old!:(value:ResourceMetrics)=>void;
  api.sampleResources.mockReturnValueOnce(new Promise(resolve=>{old=resolve;}));
  const host=document.createElement("div");const root=createRoot(host);
  try{
    await act(async()=>root.render(h(ResourceMonitorBar,{tab:tab("old")})));
    const requestId=api.sampleResources.mock.calls[0][1];
    await act(async()=>vi.advanceTimersByTimeAsync(10000));expect(api.sampleResources).toHaveBeenCalledTimes(1);
    await act(async()=>root.render(h(ResourceMonitorBar,{tab:tab("new")})));
    expect(api.cancelResourceSample).toHaveBeenCalledWith(requestId);
    await act(async()=>old({...metrics,cpuPercent:99}));expect(host.textContent).not.toContain("99.0%");
    api.sampleResources.mockReturnValueOnce(new Promise(()=>{}));
    await act(async()=>vi.advanceTimersByTimeAsync(2000));
    const current=api.sampleResources.mock.calls[2][1];
    const visibility=vi.spyOn(document,"hidden","get").mockReturnValue(true);
    await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
    expect(api.cancelResourceSample).toHaveBeenCalledWith(current);visibility.mockRestore();
    expect(api.sampleResources).toHaveBeenCalledTimes(3);
    await act(async()=>vi.advanceTimersByTimeAsync(10000));
    expect(api.sampleResources).toHaveBeenCalledTimes(3);
  }finally{act(()=>root.unmount());}
});
