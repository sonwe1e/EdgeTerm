import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import * as api from "./api";
afterEach(clearMocks);
it("carries listener direction, ownership and cancellable discovery through production IPC wrappers", async () => {
  const invoke = vi.fn();
  mockIPC(invoke);
  const spec: api.PortForwardSpec = {
    direction: "remote",
    listenHost: "::1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: 3000,
  };
  await api.startPortForward("tab", spec);
  expect(invoke).toHaveBeenLastCalledWith("start_port_forward", { id: "tab", spec });
  const dynamic: api.PortForwardSpec = {
    direction: "dynamic",
    listenHost: "127.0.0.1",
    listenPort: 1080,
  };
  await api.startPortForward("tab", dynamic);
  expect(invoke).toHaveBeenLastCalledWith("start_port_forward", { id: "tab", spec: dynamic });
  await api.discoverListeningPorts("tab", "request");
  expect(invoke).toHaveBeenLastCalledWith("discover_listening_ports", {
    id: "tab",
    requestId: "request",
  });
  await api.cancelPortDiscovery("request");
  expect(invoke).toHaveBeenLastCalledWith("cancel_port_discovery", { requestId: "request" });
  await api.stopPortForward("job");
  expect(invoke).toHaveBeenLastCalledWith("stop_port_forward", { id: "job" });
  await api.removePortForward("job");
  expect(invoke).toHaveBeenLastCalledWith("remove_port_forward", { id: "job" });
  await api.listPortForwards();
  expect(invoke).toHaveBeenLastCalledWith("list_port_forwards", {});
});
