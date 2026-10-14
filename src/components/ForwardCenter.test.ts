import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listPortForwards: vi.fn(), startPortForward: vi.fn(), stopPortForward: vi.fn(), removePortForward: vi.fn(), discoverListeningPorts: vi.fn(), cancelPortDiscovery: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
import { ForwardCenter } from "./ForwardCenter";
import { useStore, type Tab } from "../store";
import type { PortDiscovery, PortForward } from "../api";
const tab = (id: string, kind = "ssh"): Tab => ({ info: { id, address: id, kind }, state: "connected" } as Tab);
const ports: PortDiscovery = { status: "ok", ports: [{ host: "::", port: 8080, process: null }], truncated: false };
const row: PortForward = { id: "job", owner: "ssh", address: "fixture", spec: { direction: "local", listenHost: "127.0.0.1", listenPort: 1234, targetHost: "127.0.0.1", targetPort: 8080 }, status: "listening", error: null, connections: 1, sentBytes: 100, receivedBytes: 200 };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); api.listPortForwards.mockResolvedValue([]); api.discoverListeningPorts.mockResolvedValue(ports); api.cancelPortDiscovery.mockResolvedValue(undefined); api.startPortForward.mockResolvedValue(row); api.stopPortForward.mockResolvedValue(undefined); api.removePortForward.mockResolvedValue(undefined);
  useStore.setState({ tabs: [tab("ssh")], activeId: "ssh" });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("auto-discovers listeners and only creates a tab-owned tunnel after explicit submit", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(h(ForwardCenter)));
    expect(api.discoverListeningPorts).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    expect(api.discoverListeningPorts).toHaveBeenCalledWith("ssh", expect.any(String)); expect(api.startPortForward).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Use port 8080")!.click());
    expect(host.querySelector<HTMLInputElement>('[aria-label="Tunnel target host"]')!.value).toBe("::1");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.startPortForward).toHaveBeenCalledWith("ssh", { direction: "local", listenHost: "127.0.0.1", listenPort: 0, targetHost: "::1", targetPort: 8080 });
  } finally { act(() => root.unmount()); host.remove(); }
});
it("scans periodically with one in-flight request, cancels owner switches and hidden panels, and rejects stale results", async () => {
  vi.useFakeTimers(); let release!: (value: PortDiscovery) => void; api.discoverListeningPorts.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(h(ForwardCenter))); await act(async () => host.querySelector("button")!.click());
    const requestId = api.discoverListeningPorts.mock.calls[0][1];
    await act(async () => vi.advanceTimersByTimeAsync(15000)); expect(api.discoverListeningPorts).toHaveBeenCalledTimes(1);
    await act(async () => useStore.setState({ tabs: [tab("new")], activeId: "new" })); expect(api.cancelPortDiscovery).toHaveBeenCalledWith(requestId);
    await act(async () => release({ ...ports, ports: [{ host: "old", port: 9999, process: null }] })); expect(host.textContent).not.toContain("9999");
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(api.discoverListeningPorts).toHaveBeenCalledTimes(3);
    api.discoverListeningPorts.mockReturnValueOnce(new Promise(() => {})); await act(async () => vi.advanceTimersByTimeAsync(5000)); const current = api.discoverListeningPorts.mock.calls[3][1];
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true); await act(async () => document.dispatchEvent(new Event("visibilitychange"))); expect(api.cancelPortDiscovery).toHaveBeenCalledWith(current); hidden.mockRestore();
  } finally { act(() => root.unmount()); }
});
it("controls existing tunnels even on local tabs and removes only finished records", async () => {
  api.listPortForwards.mockResolvedValue([row]); useStore.setState({ tabs: [tab("local", "local")], activeId: "local" });
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(h(ForwardCenter))); await act(async () => host.querySelector("button")!.click()); expect(api.discoverListeningPorts).not.toHaveBeenCalled(); expect(host.querySelector("form")).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Stop tunnel")!.click()); expect(api.stopPortForward).toHaveBeenCalledWith("job");
    api.listPortForwards.mockResolvedValue([{ ...row, status: "stopped" }]); await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close tunnels"]')!.click()); await act(async () => host.querySelector("button")!.click());
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Remove tunnel")!.click()); expect(api.removePortForward).toHaveBeenCalledWith("job");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); expect(host.querySelector("section")).toBeNull();
  } finally { act(() => root.unmount()); }
});
