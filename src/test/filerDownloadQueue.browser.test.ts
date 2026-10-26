import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { FilerPanel } from "../components/panels/FilerPanel";
import { lastPaths, listingCache } from "../components/panels/filerDirectoryCache";
import { TransferCenter } from "../components/TransferCenter";
import { useStore, type Tab } from "../store";
import { useFileTransfers } from "../fileTransfers";
import type { FileTransfer, TransferItem } from "../api";
import * as api from "../api";
import { ask, open } from "../nativeDialog";
import "../styles.css";

const fixture = vi.hoisted(() => ({
  changed: null as ((job: FileTransfer) => void) | null,
  pending: new Map<string, { resolve: () => void; reject: (error: Error) => void }>(),
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  sftpHome: vi.fn(async () => "/queue-fixture"),
  sftpList: vi.fn(async (_id: string, path: string) => ({
    path,
    entries: Array.from({ length: 20 }, (_, index) => ({
      name: `file${index}.txt`,
      path: `${path}/file${index}.txt`,
      isDir: false,
      isSymlink: false,
      size: 100,
      modified: 1,
      permissions: null,
      owner: null,
      group: null,
    })),
  })),
  onRemoteEditState: async () => () => {},
  onFileTransfer: vi.fn(async (callback: (job: FileTransfer) => void) => {
    fixture.changed = callback;
    return () => {
      fixture.changed = null;
    };
  }),
  onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []),
  listRecoverableTransfers: vi.fn(async () => []),
  transferFiles: vi.fn(
    (sessionId: string, items: TransferItem[], _progress: unknown, transfer: string) => {
      // Scheduling here is a frontend fixture. The real manager/queue and
      // downloaded bytes are checked separately by the Rust FTP fixture.
      const index = fixture.pending.size;
      const promise = new Promise<void>((resolve, reject) =>
        fixture.pending.set(transfer, { resolve, reject }),
      );
      fixture.changed?.({
        context: {
          direction: items[0].upload ? "upload" : "download",
          firstUpload: items[0].upload,
          local: items[0].local,
          remote: items[0].remote,
          server: "test@fixture:22",
          protocol: "SFTP",
          itemCount: items.length,
        },
        id: transfer,
        sessionId,
        name: items[0].remote.split("/").pop()!,
        revision: 1,
        status: index < 2 ? "running" : "queued",
        phase: index < 2 ? "transferring" : "queued",
        transferred: 0,
        total: 100,
        completedFiles: 0,
        totalFiles: 1,
        failedFiles: [],
        error: null,
        attempt: 1,
        options: {
          requests: 32,
          chunkKib: 128,
          files: 16,
          durable: false,
          tar: false,
          rateLimitBps: 0,
        },
      });
      return promise;
    },
  ),
  controlFileTransfer: vi.fn(async (id: string, action: string) => {
    if (action !== "cancel") return;
    const job = useFileTransfers.getState().jobs[id];
    fixture.changed?.({ ...job, revision: job.revision + 1, status: "cancelled" });
    fixture.pending.get(id)!.reject(Error("transfer cancelled"));
  }),
}));
vi.mock("../nativeDialog", () => ({
  ask: vi.fn(async () => true),
  save: vi.fn(async ({ defaultPath }: { defaultPath: string }) => `/downloads/${defaultPath}`),
  open: vi.fn(async () => "/downloads"),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initialState = useStore.getState();
beforeEach(() => {
  lastPaths.clear();
  listingCache.clear();
  vi.clearAllMocks();
  fixture.pending.clear();
  useFileTransfers.setState({ jobs: {}, open: false });
  const tab: Tab = {
    info: {
      id: "queue-ssh",
      profileId: null,
      name: "Queue fixture",
      kind: "ssh",
      protocol: "ssh",
      address: "fixture",
      color: "",
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: "queue-ssh", name: "Queue fixture", kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: initialState.activePaneId,
  };
  useStore.setState(
    {
      ...initialState,
      tabs: [tab],
      activeId: tab.info.id,
      panes: [{ id: initialState.activePaneId, activeTabId: tab.info.id }],
    },
    true,
  );
  useStore.getState().setLanguage("en");
});

it("keeps browsing and submitting uploads while previous uploads are pending", async () => {
  await page.viewport(1100, 820);
  mount(h("div", { style: { width: 440, height: 720, display: "flex" } }, h(FilerPanel)));
  await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
  vi.mocked(open).mockResolvedValue(["C:/uploads/first.txt"]);
  for (let index = 0; index < 3; index++) {
    await userEvent.click(
      page.getByRole("button", { name: "Upload files or folders", exact: true }),
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Upload Files…", exact: true }));
    await expect.poll(() => vi.mocked(api.transferFiles).mock.calls.length).toBe(index + 1);
    expect(page.getByRole("button", { name: "Refresh", exact: true }).element()).not.toBeDisabled();
  }
  const destination = vi.mocked(api.transferFiles).mock.calls[0][1][0].remote;
  await userEvent.click(page.getByRole("button", { name: "Parent folder", exact: true }));
  await expect.poll(() => vi.mocked(api.sftpList).mock.calls.slice(-1)[0]?.[1]).toBe("/");
  const calls = vi.mocked(api.sftpList).mock.calls.length;
  fixture.pending.forEach((task) => task.resolve());
  await twoFrames();
  expect(vi.mocked(api.sftpList).mock.calls.length).toBe(calls);
  expect(destination).toBe("/queue-fixture/first.txt");
});

it("discards an upload picker result after switching the destination", async () => {
  let picked!: (paths: string[]) => void;
  vi.mocked(open).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        picked = resolve;
      }),
  );
  mount(h("div", { style: { width: 440, height: 720, display: "flex" } }, h(FilerPanel)));
  await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
  await userEvent.click(page.getByRole("button", { name: "Upload files or folders", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Upload Files…", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Parent folder", exact: true }));
  await twoFrames();
  picked(["C:/uploads/first.txt"]);
  await twoFrames();
  expect(api.transferFiles).not.toHaveBeenCalled();
});

it("refreshes completed uploads without clearing the user's selection", async () => {
  mount(h("div", { style: { width: 440, height: 720, display: "flex" } }, h(FilerPanel)));
  await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
  vi.mocked(open).mockResolvedValue(["C:/uploads/first.txt"]);
  await userEvent.click(page.getByRole("button", { name: "Upload files or folders", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Upload Files…", exact: true }));
  await userEvent.click(page.getByText("file2.txt", { exact: true }));
  const calls = vi.mocked(api.sftpList).mock.calls.length;
  fixture.pending.forEach((task) => task.resolve());
  await expect.poll(() => vi.mocked(api.sftpList).mock.calls.length).toBeGreaterThan(calls);
  await twoFrames();
  expect(document.querySelector('.filer-entry[aria-selected="true"]')!.textContent).toContain(
    "file2.txt",
  );
});

it("keeps overwrite refusal and cancellation quiet while failures remain visible", async () => {
  mount(
    h(
      "div",
      null,
      h("div", { style: { width: 440, height: 720, display: "flex" } }, h(FilerPanel)),
      h(TransferCenter),
    ),
  );
  await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
  const upload = async () => {
    await userEvent.click(
      page.getByRole("button", { name: "Upload files or folders", exact: true }),
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Upload Files…", exact: true }));
    await twoFrames();
  };
  vi.mocked(open).mockResolvedValue(["C:/uploads/file0.txt"]);
  vi.mocked(ask).mockResolvedValueOnce(false);
  await upload();
  expect(api.transferFiles).not.toHaveBeenCalled();
  await upload();
  const cancelled = [...fixture.pending.keys()][0];
  await api.controlFileTransfer(cancelled, "cancel");
  await twoFrames();
  expect(useStore.getState().error).toBeNull();
  await upload();
  const failed = [...fixture.pending.keys()][1];
  fixture.pending.get(failed)!.reject(Error("connection lost"));
  await expect.poll(() => useStore.getState().error).toContain("connection lost");
  expect(page.getByRole("button", { name: "Refresh", exact: true }).element()).not.toBeDisabled();
});

for (const [width, height] of [
  [1100, 720],
  [900, 560],
]) {
  it(`pins the queue without covering browsing at ${width} × ${height}`, async () => {
    await page.viewport(width, height);
    mount(
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100vh" } },
        h(
          "div",
          { className: "app-body" },
          h("div", { className: "main" }, h(FilerPanel)),
          h("div", { id: "transfer-dock", className: "transfer-dock" }),
        ),
        h("div", { className: "statusbar" }, h(TransferCenter)),
      ),
    );
    await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
    await userEvent.click(page.getByText("file0.txt", { exact: true }));
    await userEvent.click(
      page.getByRole("button", { name: "Download file or folder", exact: true }),
    );
    await userEvent.click(page.getByRole("button", { name: "Open transfer queue", exact: true }));
    const row = document.querySelector(".transfer-job")!;
    expect(row.textContent).toContain("↓ Download");
    expect(row.textContent).toContain("test@fixture:22");
    expect(row.textContent).toContain("→ /downloads/file0.txt");
    await userEvent.click(page.getByRole("button", { name: "Pin to bottom", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Parent folder", exact: true }));
    await twoFrames();
    const panel = document.querySelector<HTMLElement>("#transfer-dock .is-pinned")!;
    expect(panel).not.toBeNull();
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      document.querySelector(".main")!.getBoundingClientRect().bottom - 1,
    );
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    await page.screenshot({ path: `../../artifacts/usability/transfer-pinned-${width}.png` });
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("#transfer-dock .is-pinned")).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Unpin", exact: true }));
    expect(document.querySelector("#transfer-dock")!.children.length).toBe(0);
    await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
    expect(document.querySelector(".transfer-center-popover")).toBeNull();
  });
}
afterEach(async () => {
  await browserAfterEach();
  fixture.pending.forEach((task) => task.resolve());
  fixture.pending.clear();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  useFileTransfers.setState({ jobs: {}, open: false });
  document.documentElement.removeAttribute("data-theme");
});

for (const theme of ["dark", "light"])
  it(`submits downloads continuously and opens the real transfer center in ${theme}`, async () => {
    await page.viewport(1100, 820);
    document.documentElement.setAttribute("data-theme", theme);
    mount(
      h(
        "div",
        null,
        h(
          "div",
          { style: { width: 440, height: 720, display: "flex", margin: 24 } },
          h(FilerPanel),
        ),
        h(
          "div",
          {
            className: "statusbar",
            style: { position: "absolute", bottom: 0, width: "100%", justifyContent: "flex-end" },
          },
          h(TransferCenter),
        ),
      ),
    );
    await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBeGreaterThan(0);
    for (const name of ["file0.txt", "file1.txt", "file2.txt"]) {
      await userEvent.click(page.getByText(name, { exact: true }));
      await userEvent.click(
        page.getByRole("button", { name: "Download file or folder", exact: true }),
      );
      expect(
        page.getByRole("button", { name: "Download file or folder", exact: true }).element(),
      ).not.toBeDisabled();
    }
    expect(api.transferFiles).toHaveBeenCalledTimes(3);
    const summary = document.querySelector<HTMLElement>(".filer-transfer-summary")!;
    expect(summary.textContent).toContain("2 running · 1 queued");
    await userEvent.click(page.getByRole("button", { name: "Open transfer queue", exact: true }));
    await twoFrames();
    const popup = document.querySelector<HTMLElement>(".transfer-center-popover")!;
    expect(popup).not.toBeNull();
    expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
    await page.screenshot({ path: `../../artifacts/performance/filer-queue/${theme}.png` });
    const queued = [...popup.querySelectorAll<HTMLElement>(".transfer-job")].find((job) =>
      job.textContent!.includes("file2.txt"),
    )!;
    await userEvent.click(
      [...queued.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!,
    );
    await expect.poll(() => summary.textContent).toContain("2 running · 0 queued");
    expect(useStore.getState().error).toBeNull();
  });
