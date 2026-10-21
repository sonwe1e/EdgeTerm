import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  onFileTransfer: vi.fn(), onFileTransferRemoved: vi.fn(), listFileTransfers: vi.fn(), controlFileTransfer: vi.fn(),
  listRecoverableTransfers: vi.fn(), recoverTransfer: vi.fn(), discardRecoverableTransfer: vi.fn(),
}));
vi.mock("./api", () => api);
vi.mock("./components/icons", () => ({ Icon: () => null }));
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
import { useStore } from "./store";
import type { FileTransfer } from "./api";
import { startTransferSubscription, useFileTransfers } from "./fileTransfers";
import { TransferCenter } from "./components/TransferCenter";
import { readTransferOptions, saveTransferOptions } from "./transferSettings";

const job = (id: string, changes: Partial<FileTransfer> = {}): FileTransfer => ({
  revision: 1, id, sessionId: "ssh", name: "backup.bin", status: "running", phase: "transferring",
  transferred: 100, total: 1000, completedFiles: 0, totalFiles: 1, failedFiles: [], error: null,
  attempt: 1, options: { requests: 32, chunkKib: 128, files: 8, durable: false, tar: false, rateLimitBps: 0 }, ...changes,
});
let changed: (job: FileTransfer) => void;
let removed: (id: string) => void;
let unlisten: ReturnType<typeof vi.fn>;
let unlistenRemoved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); useFileTransfers.setState({ jobs: {}, open: false });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  unlisten = vi.fn(); unlistenRemoved = vi.fn();
  api.onFileTransfer.mockImplementation(async (callback) => { changed = callback; return unlisten; });
  api.onFileTransferRemoved.mockImplementation(async (callback) => { removed = callback; return unlistenRemoved; });
  api.listFileTransfers.mockResolvedValue([]); api.controlFileTransfer.mockResolvedValue(undefined);
  api.listRecoverableTransfers.mockResolvedValue([]); api.recoverTransfer.mockResolvedValue(undefined);
  api.discardRecoverableTransfer.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("background transfer state", () => {
  it("merges a large snapshot once while retaining newer live events and removed jobs", () => {
    const state = useFileTransfers.getState();
    state.update(job("bulk-live", { revision: 3, transferred: 900 }));
    state.update(job("bulk-removed")); state.remove("bulk-removed");
    const notified = vi.fn(); const unsubscribe = useFileTransfers.subscribe(notified);
    try {
      state.mergeSnapshot([job("bulk-live", { revision: 1 }), job("bulk-removed"), ...Array.from({ length: 1000 }, (_, index) => job(`bulk-${index}`))]);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(useFileTransfers.getState().jobs["bulk-live"].transferred).toBe(900);
      expect(useFileTransfers.getState().jobs["bulk-removed"]).toBeUndefined();
      expect(Object.keys(useFileTransfers.getState().jobs)).toHaveLength(1001);
      state.mergeSnapshot([job("bulk-live", { revision: 1 })]); expect(notified).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });
  it("refreshes mounted settings after Restore Defaults and Import", async () => {
    saveTransferOptions({ requests: 8, chunkKib: 64, files: 2, durable: true, tar: false, rateLimitBps: 0 });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const files = () => container.querySelector<HTMLInputElement>('[aria-label="Concurrent files"]')!.value;
      expect(files()).toBe("2");
      await act(async () => useStore.getState().resetSettings());
      expect(files()).toBe("16");
      await act(async () => useStore.getState().applySettings({ preferences: {
        "edgeterm.transfer-options": { requests: 4, chunkKib: 32, files: 3, durable: false, tar: false },
      } }));
      expect(files()).toBe("3");
    } finally { await act(async () => root.unmount()); }
  });
  it("refreshes the mounted rate limit after Restore Defaults and Import", async () => {
    saveTransferOptions({ requests: 8, chunkKib: 64, files: 2, durable: false, tar: false, rateLimitBps: 512 * 1024 });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const rate = () => container.querySelector<HTMLInputElement>('[aria-label^="Rate limit"]')!.value;
      expect(rate()).toBe("512");
      await act(async () => useStore.getState().resetSettings());
      expect(rate()).toBe("0");
      await act(async () => useStore.getState().applySettings({ preferences: {
        "edgeterm.transfer-options": { requests: 4, chunkKib: 32, files: 3, durable: false, tar: false, rateLimitBps: 64 * 1024 },
      } }));
      expect(rate()).toBe("64");
    } finally { await act(async () => root.unmount()); }
  });
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
    saveTransferOptions({ requests: 8, chunkKib: 32, files: 2, durable: true, tar: false, rateLimitBps: 0 });
    expect(readTransferOptions()).toEqual({ requests: 8, chunkKib: 32, files: 2, durable: true, tar: false, rateLimitBps: 0 });
    localStorage.setItem("edgeterm.transfer-options", '{"requests":1000,"chunkKib":32,"files":2}');
    expect(readTransferOptions()).toEqual({ requests: 32, chunkKib: 128, files: 16, durable: false, tar: false, rateLimitBps: 0 });
  });
  it("shows a running job's own limit beside its measured rate", async () => {
    api.listFileTransfers.mockResolvedValue([job("paced", { options: { requests: 8, chunkKib: 64, files: 2, durable: false, tar: false, rateLimitBps: 256 * 1024 } })]);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      const line = [...host.querySelectorAll(".transfer-job-details")].map((n) => n.textContent).join("\n");
      expect(line).toContain("256.0 KiB/s limit");
    } finally { act(() => root.unmount()); host.remove(); }
  });
  it("lists interrupted transfers, resumes on a matching session and forgets", async () => {
    api.listRecoverableTransfers.mockResolvedValue([
      { id: "journal-1", name: "backup.tar", kind: "sftp", endpoint: "sftp://u@host:22", host: "host", port: 22, username: "u", items: 3, checkpoints: 2, unrecognized: false },
      { id: "journal-2", name: "Unrecognized journal", kind: null, endpoint: null, host: null, port: null, username: null, items: 0, checkpoints: 0, unrecognized: true },
    ]);
    api.recoverTransfer.mockRejectedValueOnce(new Error("open a session to this journal's endpoint (sftp://u@host:22) first"));
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      await act(async () => {});
      expect(api.listRecoverableTransfers).toHaveBeenCalled();
      expect(host.textContent).toContain("Interrupted transfers (2)");
      expect(host.textContent).toContain("u@host:22");
      expect(host.textContent).toContain("3 item(s) · 2 checkpoint(s)");
      // Unrecognized journals offer Forget only.
      const resumeButtons = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Resume");
      expect(resumeButtons).toHaveLength(1);
      // A failed resume surfaces the backend's instruction, keeping the entry.
      await act(async () => resumeButtons[0].click());
      expect(api.recoverTransfer).toHaveBeenCalledWith("journal-1", expect.any(Function));
      expect(host.querySelector(".transfer-job-error")!.textContent).toContain("open a session");
      // Forgetting removes the entry and never touches the backend's jobs.
      const forgets = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Forget");
      await act(async () => forgets[forgets.length - 1].click());
      expect(api.discardRecoverableTransfer).toHaveBeenCalledWith("journal-2");
      expect(host.textContent).not.toContain("Unrecognized journal");
    } finally { act(() => root.unmount()); host.remove(); }
  });
  it("keeps a forgotten journal removed when older discovery resolves", async () => {
    const entry = { id: "forget-race", name: "forgotten tree", kind: "sftp", endpoint: "fixture", host: "host", port: 22, username: "u", items: 1, checkpoints: 1, unrecognized: false };
    let resolveOld!: (found: typeof entry[]) => void;
    // The startup discovery already listed the entry once; the popover's
    // refresh is the request still in flight when the user forgets it.
    api.listRecoverableTransfers.mockResolvedValueOnce([entry]).mockResolvedValueOnce([entry]).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const host = document.createElement("div"); const root = createRoot(host);
    const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close transfers"]')!.click());
      await act(async () => host.querySelector("button")!.click());
      await act(async () => button("Forget").click());
      expect(host.textContent).not.toContain("forgotten tree");
      await act(async () => resolveOld([entry]));
      expect(host.textContent).not.toContain("forgotten tree");
    } finally { act(() => root.unmount()); }
  });
  it("shows discovery failure and clears it after a successful retry", async () => {
    // The startup discovery fails, and so does the popover's first refresh,
    // so opening the bar names the reason; the next open succeeds.
    api.listRecoverableTransfers.mockRejectedValueOnce(new Error("discovery denied")).mockRejectedValueOnce(new Error("discovery denied")).mockResolvedValue([]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      expect(host.querySelector('[role="alert"]')!.textContent).toContain("discovery denied");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close transfers"]')!.click());
      await act(async () => host.querySelector("button")!.click());
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally { act(() => root.unmount()); }
  });
  it("displays a recovered job arriving through the production subscription", async () => {
    const entry = { id: "recover-event", name: "recovered.bin", kind: "sftp", endpoint: "fixture", host: "host", port: 22, username: "u", items: 1, checkpoints: 1, unrecognized: false };
    // The startup discovery lists it too, so the entry survives the popover's
    // own refresh until the resume clears it.
    api.listRecoverableTransfers.mockResolvedValue([entry]);
    api.recoverTransfer.mockImplementationOnce(async () => changed(job("recover-event", { name: "recovered.bin", status: "running", transferred: 600 })));
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Resume")!.click());
      expect(api.recoverTransfer).toHaveBeenCalledWith("recover-event", expect.any(Function));
      expect(host.querySelector(".transfer-center-jobs")!.textContent).toContain("600 B");
      expect(host.querySelector(".transfer-center-jobs")!.textContent).toContain("recovered.bin");
    } finally { act(() => root.unmount()); }
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
  it("summarises the whole queue on one line above the per-job cards", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("sum-a", { transferred: 400 }),
      job("sum-b", { transferred: 250, totalFiles: 2 }),
    ]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => {});
      await act(async () => host.querySelector("button")!.click());
      const total = host.querySelector(".transfer-center-total")!;
      // None of the three files done yet, 650 B of the 2.0 KiB on the wire.
      expect(total.textContent).toContain("0/3 files");
      expect(total.textContent).toContain("650 B / 2.0 KiB");
      // The cards below keep their own detail.
      expect(host.querySelectorAll(".transfer-center-jobs .transfer-job")).toHaveLength(2);
    } finally { act(() => root.unmount()); host.remove(); }
  });
  it("marks the status item red once a job has failed", async () => {
    api.listFileTransfers.mockResolvedValue([job("failed-one", { status: "error" })]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => {});
      const item = host.querySelector<HTMLButtonElement>("button.status-item")!;
      expect(item.classList.contains("is-error")).toBe(true);
      expect(item.textContent).toContain("1 failed");
    } finally { act(() => root.unmount()); host.remove(); }
  });
  it("names interrupted transfers on the status item before the popover is opened", async () => {
    api.listRecoverableTransfers.mockResolvedValue([
      { id: "journal-1", name: "backup.tar", kind: "sftp", endpoint: "sftp://u@host:22", host: "host", port: 22, username: "u", items: 3, checkpoints: 2, unrecognized: false },
    ]);
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => {});
      const item = host.querySelector<HTMLButtonElement>("button.status-item")!;
      expect(item.textContent).toContain("Interrupted transfers (1)");
      expect(item.getAttribute("title")).toContain("Interrupted transfers (1)");
    } finally { act(() => root.unmount()); host.remove(); }
  });
});
