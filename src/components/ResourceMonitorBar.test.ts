import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ sampleResources: vi.fn(), cancelResourceSample: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
import { ResourceMonitorBar } from "./ResourceMonitorBar";
import { useStore, type Tab } from "../store";
import type { ResourceMetrics } from "../api";

const GiB = 1024 * 1024 * 1024;
const metrics: ResourceMetrics = {
  status: "ok",
  cpuPercent: 12.4,
  cpuStatus: "ok",
  memory: { usedBytes: 4 * GiB, totalBytes: 16 * GiB },
  memoryStatus: "ok",
  capacity: { usedBytes: 120 * GiB, totalBytes: 256 * GiB, mount: "/" },
  capacityStatus: "ok",
  diskReadBps: 1024,
  diskWriteBps: 512,
  diskStatus: "ok",
  networkReceiveBps: 2048,
  networkSendBps: 1024,
  networkStatus: "ok",
  gpus: [
    {
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      utilization: 40,
      usedBytes: 1 * GiB,
      totalBytes: 8 * GiB,
      temperature: 55,
    },
  ],
  gpuStatus: "ok",
  npus: [
    {
      index: 0,
      name: "910B3",
      utilization: 12,
      usedBytes: 3 * GiB,
      totalBytes: 64 * GiB,
      temperature: 32,
    },
  ],
  npuStatus: "ok",
};
const tab = (id = "ssh"): Tab =>
  ({ info: { id, kind: "ssh", address: id }, state: "connected" }) as Tab;
const vitals = (host: HTMLElement) =>
  Array.from(host.querySelectorAll(".vital")).map((node) => node.textContent);
const values = (host: HTMLElement, selector: string) =>
  Array.from(host.querySelectorAll(selector)).map((node) => node.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  api.sampleResources.mockResolvedValue(metrics);
  api.cancelResourceSample.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("monitors only SSH and turns one sample into a vitals cluster plus a real popover", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ResourceMonitorBar, { tab: { ...tab(), info: { ...tab().info, kind: "local" } } }),
      ),
    );
    expect(api.sampleResources).not.toHaveBeenCalled();
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("ssh") })));
    expect(api.sampleResources).toHaveBeenCalledTimes(1);
    // One line, one reading per gauge: CPU, RAM and both detected accelerators.
    expect(vitals(host)).toEqual(["CPU12.4%", "RAM25.0%", "GPU40.0%", "NPU12.0%"]);
    const summary = host.querySelector<HTMLButtonElement>(".resource-summary")!;
    expect(summary.title).toContain("ssh");
    expect(summary.title).toContain("CPU 12.4%");
    expect(summary.title).toContain("GPU #0 NVIDIA GeForce RTX 4090 40.0%");
    expect(summary.title).toContain("NPU #0 910B3 12.0%");
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    // The shared StatusPopover frame, not a bespoke panel.
    const popover = host.querySelector(".status-popover")!;
    expect(popover.getAttribute("aria-label")).toBe("SSH host resources");
    expect(popover.querySelector(".status-popover-title")?.textContent).toBe("ssh");
    expect(popover.querySelector('[aria-label="Close resources"]')).not.toBeNull();
    // Four big readings with their unit and one quiet context line each.
    expect(values(host, ".monitor-tile-label")).toEqual(["CPU", "RAM", "Disk /", "Network"]);
    expect(values(host, ".monitor-tile-value")).toEqual(["12.4%", "25.0%", "46.9%", "↓2.0 KiB/s"]);
    expect(host.querySelector(".monitor-tile")!.querySelector(".spark")).not.toBeNull();
    // Accelerator rows exist because devices were detected, and carry the
    // reading, memory and temperature.
    expect(values(host, ".monitor-device-name")).toEqual(["NVIDIA GeForce RTX 4090", "910B3"]);
    expect(values(host, ".monitor-device-value")).toEqual(["40.0%", "12.0%"]);
    expect(host.querySelector(".monitor-device")!.textContent).toContain("1.0 GiB / 8.0 GiB");
    expect(host.querySelector(".monitor-device")!.textContent).toContain("55°C");
    // The engineering note is gone; only data and controls remain.
    expect(host.textContent).not.toContain("Rates need two samples");

    const interval = () =>
      host.querySelector<HTMLInputElement>('[aria-label="Resource sample interval in seconds"]')!;
    await act(async () =>
      useStore.getState().applySettings({
        preferences: { "edgeterm.resource-monitor": { enabled: false, intervalSeconds: 7 } },
      }),
    );
    expect(interval().value).toBe("7");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Monitor current SSH host"]')!.checked,
    ).toBe(false);
    await act(async () => useStore.getState().resetSettings());
    expect(interval().value).toBe("2");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Monitor current SSH host"]')!.checked,
    ).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it("keeps the first delta sample unknown instead of drawing a fake zero", async () => {
  api.sampleResources.mockResolvedValue({
    ...metrics,
    cpuPercent: null,
    gpus: [],
    gpuStatus: "unsupported",
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("ssh") })));
    expect(vitals(host)).toEqual(["CPU—", "RAM25.0%", "NPU12.0%"]);
  } finally {
    act(() => root.unmount());
  }
});

it("keeps an unavailable accelerator visible as a state, never as a reading", async () => {
  api.sampleResources.mockResolvedValue({
    ...metrics,
    npus: [],
    npuStatus: "denied",
    gpus: [],
    gpuStatus: "unsupported",
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("ssh") })));
    expect(vitals(host)).toEqual(["CPU12.4%", "RAM25.0%"]);
    await act(async () => host.querySelector<HTMLButtonElement>(".resource-summary")!.click());
    expect(host.querySelectorAll(".monitor-device")).toHaveLength(0);
    expect(host.querySelector(".monitor-io")!.textContent).not.toContain("NPU");
    expect(host.textContent).toContain("NPU Permission denied");
  } finally {
    act(() => root.unmount());
  }
});

it("reports an unsupported host as a state rather than an empty cluster", async () => {
  api.sampleResources.mockResolvedValue({ ...metrics, status: "unsupported", cpuPercent: null });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("ssh") })));
    expect(host.querySelectorAll(".vital")).toHaveLength(0);
    expect(host.querySelector(".resource-wide")!.textContent).toBe("Unsupported host");
    await act(async () => host.querySelector<HTMLButtonElement>(".resource-summary")!.click());
    expect(host.textContent).toContain("Resource sampling supports Linux SSH hosts.");
  } finally {
    act(() => root.unmount());
  }
});

it("keeps one in-flight sample and cancels switched or hidden hosts without stale repaint", async () => {
  vi.useFakeTimers();
  let old!: (value: ResourceMetrics) => void;
  api.sampleResources.mockReturnValueOnce(
    new Promise((resolve) => {
      old = resolve;
    }),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("old") })));
    const requestId = api.sampleResources.mock.calls[0][1];
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.sampleResources).toHaveBeenCalledTimes(1);
    await act(async () => root.render(h(ResourceMonitorBar, { tab: tab("new") })));
    expect(api.cancelResourceSample).toHaveBeenCalledWith(requestId);
    await act(async () => old({ ...metrics, cpuPercent: 99 }));
    expect(host.textContent).not.toContain("99.0%");
    api.sampleResources.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const current = api.sampleResources.mock.calls[2][1];
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.cancelResourceSample).toHaveBeenCalledWith(current);
    visibility.mockRestore();
    expect(api.sampleResources).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.sampleResources).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
  }
});
