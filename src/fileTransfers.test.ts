import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  onFileTransfer: vi.fn(), onFileTransferRemoved: vi.fn(), listFileTransfers: vi.fn(), controlFileTransfer: vi.fn(),
}));
vi.mock("./api", () => api);
vi.mock("./components/icons", () => ({ Icon: () => null }));
import type { FileTransfer } from "./api";
import { startTransferSubscription, useFileTransfers } from "./fileTransfers";
import { TransferCenter } from "./components/TransferCenter";
import { readTransferOptions, saveTransferOptions } from "./transferSettings";

const job = (id: string, changes: Partial<FileTransfer> = {}): FileTransfer => ({
  revision: 1, id, sessionId: "ssh", name: "backup.bin", status: "running", phase: "transferring",
  transferred: 100, total: 1000, completedFiles: 0, totalFiles: 1, failedFiles: [], error: null,
  attempt: 1, options: { requests: 32, chunkKib: 128, files: 8, durable: false }, ...changes,
});
let changed: (job: FileTransfer) => void;
let removed: (id: string) => void;
let unlisten: ReturnType<typeof vi.fn>;
let unlistenRemoved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); useFileTransfers.setState({ jobs: {} });
  unlisten = vi.fn(); unlistenRemoved = vi.fn();
  api.onFileTransfer.mockImplementation(async (callback) => { changed = callback; return unlisten; });
  api.onFileTransferRemoved.mockImplementation(async (callback) => { removed = callback; return unlistenRemoved; });
  api.listFileTransfers.mockResolvedValue([]); api.controlFileTransfer.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("background transfer state", () => {
  it("keeps newer events when an older initial snapshot arrives", async () => {
    api.listFileTransfers.mockImplementation(async () => {
      changed(job("race", { revision: 4, status: "paused", transferred: 500 }));
      return [job("race", { revision: 2 })];
    });
    const stop = await startTransferSubscription();
    expect(useFileTransfers.getState().jobs.race.status).toBe("paused");
    changed(job("race", { revision: 4 }));
    expect(useFileTransfers.getState().jobs.race.status).toBe("paused");
    stop(); expect(unlisten).toHaveBeenCalledOnce(); expect(unlistenRemoved).toHaveBeenCalledOnce();
  });
  it("does not resurrect a dismissed job from a late snapshot", async () => {
    api.listFileTransfers.mockImplementation(async () => {
      removed("dismiss-race"); return [job("dismiss-race")];
    });
    const stop = await startTransferSubscription();
    expect(useFileTransfers.getState().jobs["dismiss-race"]).toBeUndefined(); stop();
  });
  it("unsubscribes both listeners if initial loading fails", async () => {
    api.listFileTransfers.mockRejectedValueOnce(new Error("offline"));
    await expect(startTransferSubscription()).rejects.toThrow("offline");
    expect(unlisten).toHaveBeenCalledOnce(); expect(unlistenRemoved).toHaveBeenCalledOnce();
  });
  it("persists bounded options and rejects malformed stored limits", () => {
    saveTransferOptions({ requests: 8, chunkKib: 32, files: 2, durable: true });
    expect(readTransferOptions()).toEqual({ requests: 8, chunkKib: 32, files: 2, durable: true });
    localStorage.setItem("edgeterm.transfer-options", '{"requests":1000,"chunkKib":32,"files":2}');
    expect(readTransferOptions()).toEqual({ requests: 32, chunkKib: 128, files: 8, durable: false });
  });
  it("controls a backend job across pause/resume and terminal states", async () => {
    api.listFileTransfers.mockResolvedValue([job("controls")]);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      await act(async () => button("Pause").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "pause");
      act(() => changed(job("controls", { revision: 2, status: "paused" })));
      await act(async () => button("Resume").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "resume");
      act(() => changed(job("controls", { revision: 3, status: "error", failedFiles: ["failed.bin: denied"] })));
      await act(async () => button("Retry unfinished files").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "retry");
      await act(async () => button("Cancel").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "cancel");
      act(() => changed(job("controls", { revision: 4, status: "cancelled", error: { code: "network", message: "partial retained", retryable: true } })));
      expect(button("Dismiss")).toBeUndefined(); expect(button("Retry cleanup")).toBeDefined();
      act(() => changed(job("controls", { revision: 5, status: "cancelled" })));
      await act(async () => button("Dismiss").click());
      expect(useFileTransfers.getState().jobs.controls).toBeUndefined();
    } finally { act(() => root.unmount()); host.remove(); }
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
