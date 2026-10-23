import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdater } from "./updater";
import tauriConfig from "../src-tauri/tauri.conf.json";
import capabilities from "../src-tauri/capabilities/default.json";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  check: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.8" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("./api", () => ({ portableMode: async () => false }));

let root: Root;
let host: HTMLDivElement;
let updater: ReturnType<typeof useUpdater>;
function Harness() {
  updater = useUpdater();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("DEV", false);
  vi.useFakeTimers();
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
  mocks.check.mockReset().mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("does not contact a signed-update service on startup", async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.openUrl).not.toHaveBeenCalled();
  expect(updater.state.phase).toBe("idle");
});

it("shows manual download guidance without claiming the installed build is latest", async () => {
  await act(async () => { await updater.checkForUpdates(); });
  expect(updater.appVersion).toBe("1.2.8");
  expect(updater.state.phase).toBe("manual");
  expect(mocks.check).not.toHaveBeenCalled();
  expect(mocks.openUrl).not.toHaveBeenCalled();
});

it("opens this fork's releases only after the download action", async () => {
  await act(async () => updater.checkForUpdates());
  await act(async () => { await updater.openDownloads(); });
  expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("https://github.com/sonwe1e/EdgeTerm/releases/latest");
  expect(updater.state.phase).toBe("idle");
  expect(mocks.check).not.toHaveBeenCalled();
});

it("reports an external-browser failure and lets the user retry", async () => {
  mocks.openUrl.mockRejectedValueOnce(new Error("Browser unavailable"));
  await act(async () => updater.checkForUpdates());
  await act(async () => { await updater.openDownloads(); });
  expect(updater.state).toEqual({ phase: "error", message: "Browser unavailable" });
  await act(async () => { await updater.openDownloads(); });
  expect(updater.state.phase).toBe("idle");
  expect(mocks.openUrl).toHaveBeenCalledTimes(2);
});

it("does not reopen a dismissed dialog when opening the browser fails late", async () => {
  let rejectOpen!: (reason: Error) => void;
  mocks.openUrl.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOpen = reject; }));
  await act(async () => updater.checkForUpdates());
  let opening!: Promise<void>;
  await act(async () => { opening = updater.openDownloads(); });
  await act(async () => updater.dismiss());
  await act(async () => {
    rejectOpen(new Error("Late failure"));
    await opening;
  });
  expect(updater.state.phase).toBe("idle");
});

it("ships without a signed updater feed or permission to install its packages", () => {
  expect(tauriConfig.plugins).not.toHaveProperty("updater");
  expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(false);
  expect(capabilities.permissions).not.toContain("updater:default");
  expect(capabilities.permissions).not.toContain("process:allow-restart");
});
