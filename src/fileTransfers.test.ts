import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  onFileTransfer: vi.fn(),
  onFileTransferRemoved: vi.fn(),
  listFileTransfers: vi.fn(),
  controlFileTransfer: vi.fn(),
  listRecoverableTransfers: vi.fn(),
  recoverTransfer: vi.fn(),
  discardRecoverableTransfer: vi.fn(),
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
  context: null,
  revision: 1,
  id,
  sessionId: "ssh",
  name: "backup.bin",
  status: "running",
  phase: "transferring",
  transferred: 100,
  total: 1000,
  completedFiles: 0,
  totalFiles: 1,
  failedFiles: [],
  error: null,
  attempt: 1,
  options: { requests: 32, chunkKib: 128, files: 8, durable: false, tar: false, rateLimitBps: 0 },
  ...changes,
});
let changed: (job: FileTransfer) => void;
let removed: (id: string) => void;
let unlisten: ReturnType<typeof vi.fn>;
let unlistenRemoved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useFileTransfers.setState({ jobs: {}, open: false });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  unlisten = vi.fn();
  unlistenRemoved = vi.fn();
  api.onFileTransfer.mockImplementation(async (callback) => {
    changed = callback;
    return unlisten;
  });
  api.onFileTransferRemoved.mockImplementation(async (callback) => {
    removed = callback;
    return unlistenRemoved;
  });
  api.listFileTransfers.mockResolvedValue([]);
  api.controlFileTransfer.mockResolvedValue(undefined);
  api.listRecoverableTransfers.mockResolvedValue([]);
  api.recoverTransfer.mockResolvedValue(undefined);
  api.discardRecoverableTransfer.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("background transfer state", () => {
  it("shows location and working stages without presenting scanning as zero-percent payload", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("scan-stage", {
        phase: "scanning",
        total: 0,
        transferred: 0,
        context: {
          server: "lab@fixture:22",
          protocol: "SFTP",
          local: "C:/data",
          remote: "/srv/data",
          firstUpload: true,
          direction: "upload",
          itemCount: 3,
        },
      }),
      job("commit-stage", { phase: "committing", transferred: 1000 }),
      job("verify-stage", { phase: "verifying resume prefix" }),
    ]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      const scan = [...host.querySelectorAll(".transfer-job")].find((row) =>
        row.textContent?.includes("Scanning files"),
      )!;
      expect(scan.textContent).toContain("↑ Upload");
      expect(scan.textContent).toContain("C:/data → SFTP lab@fixture:22 /srv/data (+2 more)");
      expect(scan.querySelector('[role="progressbar"]')!.hasAttribute("aria-valuenow")).toBe(false);
      const commit = [...host.querySelectorAll(".transfer-job")].find((row) =>
        row.textContent?.includes("Finalizing file"),
      )!;
      expect(commit.querySelector(".transfer-status")!.textContent).toBe("Running");
      expect(commit.querySelector('[role="progressbar"]')!.getAttribute("aria-valuetext")).toBe(
        "Finalizing file",
      );
      expect(host.textContent).toContain("Verifying existing data");
      expect(host.querySelector('[role="progressbar"] button')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it("merges a large snapshot once while retaining newer live events and removed jobs", () => {
    const state = useFileTransfers.getState();
    state.update(job("bulk-live", { revision: 3, transferred: 900 }));
    state.update(job("bulk-removed"));
    state.remove("bulk-removed");
    const notified = vi.fn();
    const unsubscribe = useFileTransfers.subscribe(notified);
    try {
      state.mergeSnapshot([
        job("bulk-live", { revision: 1 }),
        job("bulk-removed"),
        ...Array.from({ length: 1000 }, (_, index) => job(`bulk-${index}`)),
      ]);
      expect(notified).toHaveBeenCalledTimes(1);
      expect(useFileTransfers.getState().jobs["bulk-live"].transferred).toBe(900);
      expect(useFileTransfers.getState().jobs["bulk-removed"]).toBeUndefined();
      expect(Object.keys(useFileTransfers.getState().jobs)).toHaveLength(1001);
      state.mergeSnapshot([job("bulk-live", { revision: 1 })]);
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
  it("refreshes mounted settings after Restore Defaults and Import", async () => {
    saveTransferOptions({
      requests: 8,
      chunkKib: 64,
      files: 2,
      durable: true,
      tar: false,
      rateLimitBps: 0,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const files = () =>
        container.querySelector<HTMLInputElement>('[aria-label="Concurrent files"]')!.value;
      expect(files()).toBe("2");
      await act(async () => useStore.getState().resetSettings());
      expect(files()).toBe("16");
      await act(async () =>
        useStore.getState().applySettings({
          preferences: {
            "edgeterm.transfer-options": {
              requests: 4,
              chunkKib: 32,
              files: 3,
              durable: false,
              tar: false,
            },
          },
        }),
      );
      expect(files()).toBe("3");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("refreshes the mounted rate limit after Restore Defaults and Import", async () => {
    saveTransferOptions({
      requests: 8,
      chunkKib: 64,
      files: 2,
      durable: false,
      tar: false,
      rateLimitBps: 512 * 1024,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const rate = () =>
        container.querySelector<HTMLInputElement>('[aria-label^="Rate limit"]')!.value;
      expect(rate()).toBe("512");
      await act(async () => useStore.getState().resetSettings());
      expect(rate()).toBe("0");
      await act(async () =>
        useStore.getState().applySettings({
          preferences: {
            "edgeterm.transfer-options": {
              requests: 4,
              chunkKib: 32,
              files: 3,
              durable: false,
              tar: false,
              rateLimitBps: 64 * 1024,
            },
          },
        }),
      );
      expect(rate()).toBe("64");
    } finally {
      await act(async () => root.unmount());
    }
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
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(unlistenRemoved).toHaveBeenCalledOnce();
  });
  it("does not resurrect a dismissed job from a late snapshot", async () => {
    api.listFileTransfers.mockImplementation(async () => {
      removed("dismiss-race");
      return [job("dismiss-race")];
    });
    const stop = await startTransferSubscription();
    expect(useFileTransfers.getState().jobs["dismiss-race"]).toBeUndefined();
    stop();
  });
  it("unsubscribes both listeners if initial loading fails", async () => {
    api.listFileTransfers.mockRejectedValueOnce(new Error("offline"));
    await expect(startTransferSubscription()).rejects.toThrow("offline");
    expect(unlisten).toHaveBeenCalledOnce();
    expect(unlistenRemoved).toHaveBeenCalledOnce();
  });
  it("persists bounded options and rejects malformed stored limits", () => {
    saveTransferOptions({
      requests: 8,
      chunkKib: 32,
      files: 2,
      durable: true,
      tar: false,
      rateLimitBps: 0,
    });
    expect(readTransferOptions()).toEqual({
      requests: 8,
      chunkKib: 32,
      files: 2,
      durable: true,
      tar: false,
      rateLimitBps: 0,
    });
    localStorage.setItem("edgeterm.transfer-options", '{"requests":1000,"chunkKib":32,"files":2}');
    expect(readTransferOptions()).toEqual({
      requests: 32,
      chunkKib: 128,
      files: 16,
      durable: false,
      tar: false,
      rateLimitBps: 0,
    });
  });
  it("shows a running job's own limit beside its measured rate", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("paced", {
        options: {
          requests: 8,
          chunkKib: 64,
          files: 2,
          durable: false,
          tar: false,
          rateLimitBps: 256 * 1024,
        },
      }),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      const line = [...host.querySelectorAll(".transfer-job-meta-text")]
        .map((n) => n.textContent)
        .join("\n");
      expect(line).toContain("limit 256.0 KiB/s");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("lists interrupted transfers, resumes on a matching session and forgets", async () => {
    api.listRecoverableTransfers.mockResolvedValue([
      {
        id: "journal-1",
        name: "backup.tar",
        kind: "sftp",
        endpoint: "sftp://u@host:22",
        host: "host",
        port: 22,
        username: "u",
        items: 3,
        checkpoints: 2,
        unrecognized: false,
      },
      {
        id: "journal-2",
        name: "Unrecognized journal",
        kind: null,
        endpoint: null,
        host: null,
        port: null,
        username: null,
        items: 0,
        checkpoints: 0,
        unrecognized: true,
      },
    ]);
    api.recoverTransfer.mockRejectedValueOnce(
      new Error("open a session to this journal's endpoint (sftp://u@host:22) first"),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      await act(async () => {});
      expect(api.listRecoverableTransfers).toHaveBeenCalled();
      expect(host.textContent).toContain("Interrupted (2)");
      expect(host.textContent).toContain("u@host:22");
      expect(host.textContent).toContain("3 items");
      // Unrecognized journals offer Clear only.
      const resumeButtons = [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === "Resume",
      );
      expect(resumeButtons).toHaveLength(1);
      // A failed resume surfaces the backend's instruction, keeping the entry.
      await act(async () => resumeButtons[0].click());
      expect(api.recoverTransfer).toHaveBeenCalledWith("journal-1", expect.any(Function));
      expect(host.querySelector('[role="alert"]')!.textContent).toContain("open a session");
      // Clearing removes the entry and never touches the backend's jobs.
      const forgets = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Clear");
      await act(async () => forgets[forgets.length - 1].click());
      expect(api.discardRecoverableTransfer).toHaveBeenCalledWith("journal-2");
      expect(host.textContent).not.toContain("Unrecognized journal");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("clears every interrupted record from the recovery header after one confirmation", async () => {
    api.listRecoverableTransfers.mockResolvedValue([
      {
        id: "journal-1",
        name: "backup.tar",
        kind: "sftp",
        endpoint: "sftp://u@host:22",
        host: "host",
        port: 22,
        username: "u",
        items: 3,
        checkpoints: 2,
        unrecognized: false,
      },
      {
        id: "journal-2",
        name: "Unrecognized journal",
        kind: null,
        endpoint: null,
        host: null,
        port: null,
        username: null,
        items: 0,
        checkpoints: 0,
        unrecognized: true,
      },
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const headerButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".transfer-section-head button")].find(
        (b) => b.textContent === "Clear interrupted",
      );
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () => {});
      await act(async () => headerButton()!.click());
      const band = host.querySelector<HTMLElement>(".transfer-clear-band")!;
      expect(band.textContent).toContain("Clear 2 interrupted transfers?");
      expect(band.textContent).toContain("Partial files stay on the server.");
      expect(api.discardRecoverableTransfer).not.toHaveBeenCalled();
      // Cancelling keeps every entry.
      await act(async () =>
        [...band.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click(),
      );
      expect(api.discardRecoverableTransfer).not.toHaveBeenCalled();
      expect(host.textContent).toContain("backup.tar");
      // Confirming discards each journal — the unrecognized one too — and
      // empties the section without another discovery round trip.
      await act(async () => headerButton()!.click());
      const confirmBand = host.querySelector<HTMLElement>(".transfer-clear-band")!;
      await act(async () =>
        [...confirmBand.querySelectorAll("button")].find((b) => b.textContent === "Clear")!.click(),
      );
      expect(api.discardRecoverableTransfer.mock.calls.map(([id]) => id).sort()).toEqual([
        "journal-1",
        "journal-2",
      ]);
      expect(host.textContent).not.toContain("backup.tar");
      expect(host.textContent).not.toContain("Unrecognized journal");
      expect(host.querySelector(".transfer-recovery")).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("keeps a forgotten journal removed when older discovery resolves", async () => {
    const entry = {
      id: "forget-race",
      name: "forgotten tree",
      kind: "sftp",
      endpoint: "fixture",
      host: "host",
      port: 22,
      username: "u",
      items: 1,
      checkpoints: 1,
      unrecognized: false,
    };
    let resolveOld!: (found: (typeof entry)[]) => void;
    // The startup discovery already listed the entry once; the popover's
    // refresh is the request still in flight when the user forgets it.
    api.listRecoverableTransfers
      .mockResolvedValueOnce([entry])
      .mockResolvedValueOnce([entry])
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      );
    const host = document.createElement("div");
    const root = createRoot(host);
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Close transfers"]')!.click(),
      );
      await act(async () => host.querySelector("button")!.click());
      await act(async () => button("Clear").click());
      expect(host.textContent).not.toContain("forgotten tree");
      await act(async () => resolveOld([entry]));
      expect(host.textContent).not.toContain("forgotten tree");
    } finally {
      act(() => root.unmount());
    }
  });
  it("shows discovery failure and clears it after a successful retry", async () => {
    // The startup discovery fails, and so does the popover's first refresh,
    // so opening the bar names the reason; the next open succeeds.
    api.listRecoverableTransfers
      .mockRejectedValueOnce(new Error("discovery denied"))
      .mockRejectedValueOnce(new Error("discovery denied"))
      .mockResolvedValue([]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      expect(host.querySelector('[role="alert"]')!.textContent).toContain("discovery denied");
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Close transfers"]')!.click(),
      );
      await act(async () => host.querySelector("button")!.click());
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it("displays a recovered job arriving through the production subscription", async () => {
    const entry = {
      id: "recover-event",
      name: "recovered.bin",
      kind: "sftp",
      endpoint: "fixture",
      host: "host",
      port: 22,
      username: "u",
      items: 1,
      checkpoints: 1,
      unrecognized: false,
    };
    // The startup discovery lists it too, so the entry survives the popover's
    // own refresh until the resume clears it.
    api.listRecoverableTransfers.mockResolvedValue([entry]);
    api.recoverTransfer.mockImplementationOnce(async () =>
      changed(job("recover-event", { name: "recovered.bin", status: "running", transferred: 600 })),
    );
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () =>
        [...host.querySelectorAll("button")].find((b) => b.textContent === "Resume")!.click(),
      );
      expect(api.recoverTransfer).toHaveBeenCalledWith("recover-event", expect.any(Function));
      expect(host.querySelector(".transfer-center-jobs")!.textContent).toContain("600 B");
      expect(host.querySelector(".transfer-center-jobs")!.textContent).toContain("recovered.bin");
    } finally {
      act(() => root.unmount());
    }
  });
  it("controls a backend job across pause/resume and terminal states", async () => {
    api.listFileTransfers.mockResolvedValue([job("controls")]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    try {
      await act(async () => root.render(h(TransferCenter)));
      act(() => host.querySelector("button")!.click());
      await act(async () => button("Pause").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "pause");
      act(() => changed(job("controls", { revision: 2, status: "paused" })));
      await act(async () => button("Resume").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "resume");
      act(() =>
        changed(
          job("controls", { revision: 3, status: "error", failedFiles: ["failed.bin: denied"] }),
        ),
      );
      await act(async () => button("Retry").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "retry");
      await act(async () => button("Cancel").click());
      expect(api.controlFileTransfer).toHaveBeenLastCalledWith("controls", "cancel");
      act(() =>
        changed(
          job("controls", {
            revision: 4,
            status: "cancelled",
            error: { code: "network", message: "partial retained", retryable: true },
          }),
        ),
      );
      expect(button("Clear")).toBeUndefined();
      expect(button("Retry cleanup")).toBeDefined();
      act(() => changed(job("controls", { revision: 5, status: "cancelled" })));
      await act(async () => button("Clear").click());
      expect(useFileTransfers.getState().jobs.controls).toBeUndefined();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("summarises the whole queue on one line above the per-job cards", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("sum-a", { transferred: 400 }),
      job("sum-b", { transferred: 250, totalFiles: 2 }),
    ]);
    const host = document.createElement("div");
    const root = createRoot(host);
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
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("marks the status item red once a job has failed", async () => {
    api.listFileTransfers.mockResolvedValue([job("failed-one", { status: "error" })]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => {});
      const item = host.querySelector<HTMLButtonElement>("button.status-item")!;
      expect(item.classList.contains("is-error")).toBe(true);
      expect(item.textContent).toContain("1 failed");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("names interrupted transfers on the status item before the popover is opened", async () => {
    api.listRecoverableTransfers.mockResolvedValue([
      {
        id: "journal-1",
        name: "backup.tar",
        kind: "sftp",
        endpoint: "sftp://u@host:22",
        host: "host",
        port: 22,
        username: "u",
        items: 3,
        checkpoints: 2,
        unrecognized: false,
      },
    ]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => {});
      const item = host.querySelector<HTMLButtonElement>("button.status-item")!;
      expect(item.textContent).toContain("Interrupted (1)");
      expect(item.getAttribute("title")).toContain("Interrupted (1)");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("opens as a queue: shared frame, one totals line, settings collapsed", async () => {
    api.listFileTransfers.mockResolvedValue([job("queue-row", { status: "running" })]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      const popover = host.querySelector(".transfer-center-popover")!;
      // The shared frame owns the title and the close control.
      expect(popover.classList.contains("status-popover")).toBe(true);
      expect(popover.querySelector(".status-popover-title")!.textContent).toBe("Transfers");
      expect(popover.querySelector(".status-popover-close")).not.toBeNull();
      // No intro copy and no explanatory notes: the queue explains itself.
      expect(popover.querySelector("details.transfer-settings")!.hasAttribute("open")).toBe(false);
      expect(popover.querySelectorAll(".transfer-center-total")).toHaveLength(1);
      expect(popover.textContent).not.toContain("Transfers continue while this app is open");
      expect(popover.textContent).not.toContain("not the number of parallel tasks");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("asks before clearing a failed record and sends nothing until confirmed", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("clear-me", {
        name: "broken.bin",
        status: "error",
        error: { code: "network", message: "connection reset", retryable: true },
      }),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const row = () => host.querySelector<HTMLElement>(".transfer-job")!;
    const rowButton = (label: string) =>
      [...row().querySelectorAll("button")].find((b) => b.textContent === label);
    const confirmBand = () => host.querySelector<HTMLElement>(".transfer-job.is-confirming");
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () => rowButton("Clear")!.click());
      // The row asks first; the backend is never told to dismiss on the click.
      expect(api.controlFileTransfer).not.toHaveBeenCalled();
      expect(confirmBand()!.textContent).toContain("Clear failed transfer?");
      expect(confirmBand()!.textContent).toContain("Partial files stay on the server.");
      // Cancelling restores the row and still sends nothing.
      await act(async () =>
        [...confirmBand()!.querySelectorAll("button")]
          .find((b) => b.textContent === "Cancel")!
          .click(),
      );
      expect(confirmBand()).toBeNull();
      expect(api.controlFileTransfer).not.toHaveBeenCalled();
      expect(useFileTransfers.getState().jobs["clear-me"]).toBeDefined();
      // Confirming dismisses the record.
      await act(async () => rowButton("Clear")!.click());
      await act(async () =>
        [...confirmBand()!.querySelectorAll("button")]
          .find((b) => b.textContent === "Clear")!
          .click(),
      );
      expect(api.controlFileTransfer).toHaveBeenCalledTimes(1);
      expect(api.controlFileTransfer).toHaveBeenCalledWith("clear-me", "dismiss");
      expect(useFileTransfers.getState().jobs["clear-me"]).toBeUndefined();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("clears every failed record from the header after one confirmation", async () => {
    const failure = { code: "network", message: "connection reset", retryable: true };
    api.listFileTransfers.mockResolvedValue([
      job("bulk-fail-a", { name: "a.bin", status: "error", error: failure }),
      job("bulk-fail-b", { name: "b.bin", status: "error", error: failure }),
      job("bulk-done", { name: "c.bin", status: "complete" }),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const headerButton = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>(".status-popover-head button")].find(
        (b) => b.textContent === label,
      );
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      await act(async () => headerButton("Clear failed")!.click());
      const band = host.querySelector<HTMLElement>(".transfer-clear-band")!;
      expect(band.textContent).toContain("Clear 2 failed transfers?");
      expect(band.textContent).toContain("Partial files stay on the server.");
      expect(api.controlFileTransfer).not.toHaveBeenCalled();
      await act(async () =>
        [...band.querySelectorAll("button")].find((b) => b.textContent === "Clear")!.click(),
      );
      expect(api.controlFileTransfer.mock.calls.map(([id]) => id).sort()).toEqual([
        "bulk-fail-a",
        "bulk-fail-b",
      ]);
      // The completed record was not part of "failed".
      expect(Object.keys(useFileTransfers.getState().jobs)).toEqual(["bulk-done"]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("clears finished records at once but never a failure or an active job", async () => {
    const failure = { code: "network", message: "connection reset", retryable: true };
    api.listFileTransfers.mockResolvedValue([
      job("fin-done", { name: "done.bin", status: "complete" }),
      job("fin-stopped", { name: "stopped.bin", status: "cancelled" }),
      job("fin-failed", { name: "failed.bin", status: "error", error: failure }),
      job("fin-busy", { name: "busy.bin", status: "running" }),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const labels = (name: string) => {
      const row = [...host.querySelectorAll<HTMLElement>(".transfer-job")].find((n) =>
        n.textContent!.includes(name),
      )!;
      return [...row.querySelectorAll("button")].map((b) => b.textContent);
    };
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      // An active transfer never offers the plain clear action.
      expect(labels("busy.bin")).not.toContain("Clear");
      expect(labels("done.bin")).toContain("Clear");
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>(".status-popover-head button")]
          .find((b) => b.textContent === "Clear finished")!
          .click(),
      );
      expect(api.controlFileTransfer.mock.calls.map(([id]) => id).sort()).toEqual([
        "fin-done",
        "fin-stopped",
      ]);
      expect(Object.keys(useFileTransfers.getState().jobs).sort()).toEqual([
        "fin-busy",
        "fin-failed",
      ]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it("lists failed files under the queue and closes the list", async () => {
    api.listFileTransfers.mockResolvedValue([
      job("fail-list", {
        name: "tree.bin",
        status: "error",
        error: { code: "network", message: "connection reset", retryable: true },
        failedFiles: ["a.bin: denied", "b.bin: timeout"],
      }),
    ]);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(TransferCenter)));
      await act(async () => host.querySelector("button")!.click());
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "2 failed files",
      )!;
      expect(link.getAttribute("aria-expanded")).toBe("false");
      await act(async () => link.click());
      const section = host.querySelector('[aria-label="Failed files"]')!;
      expect(section.textContent).toContain("tree.bin · 2 failed files");
      expect(section.textContent).toContain("a.bin: denied");
      expect(section.textContent).toContain("b.bin: timeout");
      await act(async () =>
        section.querySelector<HTMLButtonElement>('[aria-label="Close failed files"]')!.click(),
      );
      expect(host.querySelector('[aria-label="Failed files"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
