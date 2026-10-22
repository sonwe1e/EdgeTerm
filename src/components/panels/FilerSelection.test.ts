import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("../../platform", () => ({ HAS_TRAY: true, get IS_MAC() { return platform.mac; }, get IS_WINDOWS() { return !platform.mac; } }));
vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../../actions", () => ({ revealCwdInFiler: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../nativeDialog", () => ({ ask: vi.fn(async () => true), open: vi.fn(), save: vi.fn() }));
vi.mock("../../api", async (original) => ({
  ...await original<typeof import("../../api")>(),
  localHome: vi.fn(), localList: vi.fn(), localRemove: vi.fn(), sftpRemove: vi.fn(),
  sftpHome: vi.fn(), sftpList: vi.fn(), transferFiles: vi.fn(), startFileDrag: vi.fn(),
  dragStagingPath: vi.fn(), cancelTransfer: vi.fn(),
  localRename: vi.fn(), sftpRename: vi.fn(),
  sftpDownload: vi.fn(), sftpDownloadDirectory: vi.fn(),
  onFileTransfer: vi.fn(async () => () => {}), onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []), listRecoverableTransfers: vi.fn(async () => []),
  controlFileTransfer: vi.fn(),
  onRemoteEditState: async () => () => {},
}));

import * as api from "../../api";
import * as nativeDialog from "../../nativeDialog";
import { useStore, type Tab } from "../../store";
import type { FileEntry } from "../../types";
import { FilerPanel } from "./FilerPanel";
import { lastPaths, listingCache } from "./filerDirectoryCache";
import { useFileTransfers } from "../../fileTransfers";
import { TransferCenter } from "../TransferCenter";

const initialState = useStore.getState();
const entries: FileEntry[] = ["file10.txt", "file2.txt", "file3.txt", "folder"].map((name) => ({
  name, path: `/selection/${name}`, isDir: name === "folder", isSymlink: false,
  size: 10, modified: 1, permissions: null, owner: null, group: null,
}));
let host: HTMLDivElement;
let root: Root;
const rows = () => [...host.querySelectorAll<HTMLElement>(".filer-entry")];
const row = (name: string) => rows().find((element) => element.querySelector(".row-label")!.textContent === name)!;
const chosen = () => rows().filter((element) => element.classList.contains("is-active"))
  .map((element) => element.querySelector(".row-label")!.textContent);
const press = (name: string, options: MouseEventInit = {}) => act(() => {
  row(name).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...options }));
});
const toolbar = (label: string) => host.querySelector<HTMLButtonElement>(`.filer-toolbar [aria-label="${label}"]`)!;
const context = (name: string) => act(() => {
  row(name).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
  row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
});
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .find((element) => element.textContent?.trim() === label)!;
/** Rename surfaces print the message key until the locales carry it. */
const RENAME_LABELS = ["filer.rename", "Rename"];
const renameButton = () => [...host.querySelectorAll<HTMLButtonElement>(".filer-toolbar button")]
  .find((button) => RENAME_LABELS.includes(button.getAttribute("aria-label") ?? ""))!;
const renameMenuItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .find((element) => RENAME_LABELS.includes(element.textContent?.trim() ?? ""))!;
/** Types into an input the way a user would, through React's value tracker. */
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const remoteTab = (id = "selection-ssh"): Tab => ({
  info: { id, profileId: null, name: id, kind: "ssh", protocol: "ssh", address: "fixture",
    color: "", supportsRemoteFiles: true, recording: null, legacyAlgorithms: [], sharedConnection: false },
  profile: { id, name: id, kind: "ssh" }, number: 1, ordinal: 0, state: "connected",
  commandActivity: "idle", activityKind: "command", cols: 80, rows: 24, paneId: initialState.activePaneId,
});
const useRemote = () => {
  const tab = remoteTab();
  useStore.setState({ tabs: [tab], activeId: tab.info.id,
    panes: [{ id: initialState.activePaneId, activeTabId: tab.info.id }] });
};
async function drag(name: string) {
  const element = row(name);
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = () => false;
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 20 }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  platform.mac = false;
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", tabs: [], activeId: null }, true);
  useFileTransfers.setState({ jobs: {}, open: false });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // The panel remembers the last directory per source in module scope, the way
  // a hidden panel keeps it; without this a test that navigates (Home, a
  // double-click into a folder) would leave its path behind for the next one.
  lastPaths.clear();
  listingCache.clear();
  vi.mocked(api.localHome).mockResolvedValue("/selection");
  vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries }));
  vi.mocked(api.sftpHome).mockResolvedValue("/selection");
  vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({ path, entries }));
  vi.mocked(api.localRemove).mockResolvedValue();
  vi.mocked(api.sftpRemove).mockResolvedValue();
  vi.mocked(api.localRename).mockResolvedValue();
  vi.mocked(api.sftpRename).mockResolvedValue();
  vi.mocked(api.transferFiles).mockResolvedValue();
  vi.mocked(api.sftpDownload).mockImplementation((id, remote, local, progress, transfer) =>
    api.transferFiles(id, [{ local, remote, upload: false, directory: false }], progress, transfer));
  vi.mocked(api.sftpDownloadDirectory).mockImplementation((id, remote, local, progress, transfer) =>
    api.transferFiles(id, [{ local, remote, upload: false, directory: true }], progress, transfer));
  vi.mocked(api.startFileDrag).mockResolvedValue();
  vi.mocked(api.dragStagingPath).mockImplementation(async (name) => `/staging/${name}`);
  vi.mocked(api.cancelTransfer).mockResolvedValue();
  vi.mocked(api.controlFileTransfer).mockResolvedValue();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  useStore.setState(initialState, true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(h(FilerPanel)));
const transferJob = (id: string, name: string, status: api.FileTransfer["status"]): api.FileTransfer => ({
  id, name, status, sessionId: "selection-ssh", revision: 1, phase: status,
  transferred: 0, total: 100, completedFiles: 0, totalFiles: 1, failedFiles: [], error: null,
  attempt: status === "queued" ? 0 : 1,
  options: { requests: 32, chunkKib: 128, files: 16, durable: false, tar: false, rateLimitBps: 0 },
});

describe("Filer multiple selection at the real panel entry", () => {
  it("adds and toggles paths with Ctrl instead of replacing the selection", async () => {
    await mount();
    press("file10.txt");
    press("file3.txt", { ctrlKey: true });
    expect(chosen()).toEqual(["file3.txt", "file10.txt"]);
    press("file10.txt", { ctrlKey: true });
    expect(chosen()).toEqual(["file3.txt"]);
    press("file2.txt");
    expect(chosen()).toEqual(["file2.txt"]);
    press("file2.txt", { ctrlKey: true });
    expect(chosen()).toEqual([]);
    expect(toolbar("Delete").disabled).toBe(true);
  });

  it("uses displayed order for Shift ranges and keeps paths selected after sorting", async () => {
    await mount();
    press("file10.txt"); press("file2.txt", { shiftKey: true });
    expect(chosen()).toEqual(["file2.txt", "file3.txt", "file10.txt"]);
    act(() => useStore.getState().setFilerSort({ key: "name", direction: "asc", explicit: true }));
    expect(chosen()).toEqual(["file2.txt", "file3.txt", "file10.txt"]);
    press("folder"); press("file3.txt", { shiftKey: true });
    expect(chosen()).toEqual(["folder", "file2.txt", "file3.txt"]);
  });

  it("uses Command for additive selection on macOS", async () => {
    platform.mac = true;
    await mount();
    press("file10.txt"); press("file3.txt", { metaKey: true });
    expect(chosen()).toEqual(["file3.txt", "file10.txt"]);
    press("file10.txt", { metaKey: true });
    expect(chosen()).toEqual(["file3.txt"]);
  });

  it("supports Ctrl+A and Escape within the list and clears selection on refresh", async () => {
    await mount();
    const list = host.querySelector<HTMLElement>(".filer-list")!;
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })));
    expect(chosen()).toHaveLength(4);
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(4);
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(chosen()).toEqual([]);
    press("file10.txt"); press("file3.txt", { ctrlKey: true });
    await act(async () => toolbar("Refresh").click());
    expect(chosen()).toEqual([]);
  });

  it("preserves a right-clicked group and copies every selected path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    await mount();
    press("file10.txt"); press("file3.txt", { ctrlKey: true });
    context("file10.txt");
    expect(chosen()).toEqual(["file3.txt", "file10.txt"]);
    await act(async () => menuItem("Copy Path").click());
    expect(write).toHaveBeenCalledWith("/selection/file3.txt\n/selection/file10.txt");
    context("file2.txt");
    expect(chosen()).toEqual(["file2.txt"]);
  });

  for (const remote of [false, true]) it(`confirms and removes the complete ${remote ? "remote" : "local"} selection`, async () => {
    if (remote) useRemote();
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    act(() => toolbar("Delete").click());
    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("2 selected items");
    expect(dialog.textContent).toContain("/selection/file10.txt");
    expect(dialog.textContent).toContain("/selection/folder");
    expect(api.localRemove).not.toHaveBeenCalled(); expect(api.sftpRemove).not.toHaveBeenCalled();
    await act(async () => dialog.querySelector<HTMLButtonElement>(".is-danger")!.click());
    if (remote) {
      expect(vi.mocked(api.sftpRemove).mock.calls).toEqual([
        ["selection-ssh", "/selection/folder", true, true],
        ["selection-ssh", "/selection/file10.txt", false, false],
      ]);
    } else {
      expect(vi.mocked(api.localRemove).mock.calls).toEqual([
        ["/selection/folder", true, true],
        ["/selection/file10.txt", false, false],
      ]);
    }
    expect(chosen()).toEqual([]);
  });

  it("says a folder goes with its contents and asks the backend to delete recursively", async () => {
    await mount();
    press("folder");
    act(() => toolbar("Delete").click());
    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Delete Folder");
    expect(dialog.textContent).toContain("everything inside it");
    const danger = dialog.querySelector<HTMLButtonElement>(".is-danger")!;
    expect(danger.textContent).toBe("Delete Folder and Contents");
    // Enter on an untouched dialog must still cancel, not delete.
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    expect(document.activeElement).toBe(cancel);
    await act(async () => danger.click());
    expect(vi.mocked(api.localRemove).mock.calls).toEqual([
      ["/selection/folder", true, true],
    ]);
  });

  it("deletes a single file without the recursive flag", async () => {
    await mount();
    press("file2.txt");
    act(() => toolbar("Delete").click());
    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).not.toContain("everything inside it");
    const danger = dialog.querySelector<HTMLButtonElement>(".is-danger")!;
    expect(danger.textContent).toBe("Delete");
    await act(async () => danger.click());
    expect(vi.mocked(api.localRemove).mock.calls).toEqual([
      ["/selection/file2.txt", false, false],
    ]);
  });

  it("keeps failed deletions selected, reports errors, and continues the other selected items", async () => {
    const removed = new Set<string>();
    vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries: entries.filter((entry) => !removed.has(entry.path)) }));
    vi.mocked(api.localRemove).mockImplementation(async (path) => {
      if (path.endsWith("file2.txt")) throw Error("permission denied");
      removed.add(path);
    });
    await mount();
    press("file10.txt"); press("file2.txt", { shiftKey: true });
    act(() => toolbar("Delete").click());
    await act(async () => host.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click());
    expect(api.localRemove).toHaveBeenCalledTimes(3);
    expect(chosen()).toEqual(["file2.txt"]);
    expect(host.textContent).toContain("file2.txt: permission denied");
  });

  it("cancels deletion without removing anything and closes stale confirmations on a source change", async () => {
    await mount();
    press("file10.txt"); press("file3.txt", { ctrlKey: true });
    act(() => toolbar("Delete").click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".confirm-dialog button")]
      .find((button) => button.textContent === "Cancel")!.click());
    expect(api.localRemove).not.toHaveBeenCalled();
    act(() => toolbar("Delete").click());
    await act(async () => useRemote());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(chosen()).toEqual([]);
  });

  it("downloads all selected files and folders in one transfer plan", async () => {
    useRemote();
    vi.mocked(nativeDialog.open).mockResolvedValue("/downloads");
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await act(async () => toolbar("Download file or folder").click());
    expect(api.transferFiles).toHaveBeenCalledWith("selection-ssh", [
      { local: "/downloads/folder", remote: "/selection/folder", upload: false, directory: true },
      { local: "/downloads/file10.txt", remote: "/selection/file10.txt", upload: false, directory: false },
    ], expect.any(Function), expect.any(String));
  });

  it("asks before a directory download overwrites a same-named item", async () => {
    useRemote();
    vi.mocked(nativeDialog.open).mockResolvedValue("/downloads");
    vi.mocked(api.localList).mockImplementation(async (path) => ({
      path,
      entries: path === "/downloads" ? [entries[0]] : entries,
    }));
    vi.mocked(nativeDialog.ask).mockResolvedValue(false);
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await act(async () => toolbar("Download file or folder").click());
    expect(nativeDialog.ask).toHaveBeenCalledWith(
      expect.stringContaining("1 item(s)"),
      expect.objectContaining({ title: "Replace Existing Items" }),
    );
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("accepts another download while earlier downloads are still pending", async () => {
    useRemote();
    const complete: (() => void)[] = [];
    vi.mocked(api.transferFiles).mockImplementation(() => new Promise<void>((resolve) => { complete.push(resolve); }));
    vi.mocked(nativeDialog.save).mockResolvedValueOnce("/downloads/first.txt").mockResolvedValueOnce("/downloads/second.txt");
    await mount();
    press("file10.txt");
    await act(async () => toolbar("Download file or folder").click());
    expect(api.transferFiles).toHaveBeenCalledTimes(1);
    expect(toolbar("Download file or folder").disabled).toBe(false);
    press("file2.txt");
    await act(async () => toolbar("Download file or folder").click());
    expect(api.transferFiles).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(api.transferFiles).mock.calls;
    expect(calls[0][1]).toEqual([{ local: "/downloads/first.txt", remote: "/selection/file10.txt", upload: false, directory: false }]);
    expect(calls[1][1]).toEqual([{ local: "/downloads/second.txt", remote: "/selection/file2.txt", upload: false, directory: false }]);
    expect(calls[0][3]).not.toBe(calls[1][3]);
    await act(async () => complete.forEach((resolve) => resolve()));
  });

  it("shows backend queue states and opens the transfer center to cancel a waiting job", async () => {
    useRemote();
    const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
    vi.mocked(api.transferFiles).mockImplementation(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
    vi.mocked(nativeDialog.save).mockResolvedValue("/downloads/target.txt");
    await act(async () => root.render(h("div", null, h(FilerPanel), h(TransferCenter))));
    for (const name of ["file10.txt", "file2.txt", "file3.txt"]) {
      press(name);
      await act(async () => toolbar("Download file or folder").click());
    }
    expect(api.transferFiles).toHaveBeenCalledTimes(3);
    const ids = vi.mocked(api.transferFiles).mock.calls.map((call) => call[3]!);
    const snapshots = ids.map((id, index) => transferJob(id, `job-${index}`, index < 2 ? "running" : "queued"));
    act(() => snapshots.forEach((job) => useFileTransfers.getState().update(job)));
    expect(host.querySelector(".filer-transfer-summary")!.textContent).toContain("2 running · 1 queued");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Open transfer queue"]')!.click());
    expect(host.querySelector(".transfer-center-popover")).not.toBeNull();
    const queued = [...host.querySelectorAll<HTMLElement>(".transfer-job")].find((job) => job.textContent!.includes("job-2"))!;
    await act(async () => [...queued.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(api.controlFileTransfer).toHaveBeenCalledWith(ids[2], "cancel");
    await act(async () => {
      useFileTransfers.getState().update({ ...snapshots[2], revision: 2, status: "cancelled" });
      pending[2].reject(Error("transfer cancelled"));
    });
    expect(useStore.getState().error).toBeNull();
    expect(host.querySelector(".filer-transfer-summary")!.textContent).toContain("2 running · 0 queued");
    await act(async () => { pending[0].resolve(); pending[1].resolve(); });
  });

  it("keeps a later job independent when an earlier download fails after the panel unmounts", async () => {
    useRemote();
    let failFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    vi.mocked(api.transferFiles)
      .mockReturnValueOnce(new Promise((_, reject) => { failFirst = reject; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { finishSecond = resolve; }));
    vi.mocked(nativeDialog.save).mockResolvedValue("/downloads/target.txt");
    await mount();
    press("file10.txt"); await act(async () => toolbar("Download file or folder").click());
    press("file2.txt"); await act(async () => toolbar("Download file or folder").click());
    act(() => root.render(null));
    await act(async () => failFirst(Error("connection lost")));
    expect(useStore.getState().error).toContain("file10.txt");
    expect(useStore.getState().error).toContain("connection lost");
    expect(useStore.getState().errorSessionId).toBe("selection-ssh");
    await act(async () => finishSecond());
    expect(api.cancelTransfer).not.toHaveBeenCalled();
  });

  it("serializes destination pickers and rejects a stale single-file selection", async () => {
    useRemote();
    let choose!: (value: string) => void;
    vi.mocked(nativeDialog.save).mockReturnValueOnce(new Promise((resolve) => { choose = resolve; }));
    await mount();
    press("file10.txt"); act(() => toolbar("Download file or folder").click());
    expect(toolbar("Download file or folder").disabled).toBe(true);
    act(() => toolbar("Download file or folder").click());
    expect(nativeDialog.save).toHaveBeenCalledTimes(1);
    await act(async () => useStore.setState({ tabs: [], activeId: null }));
    await act(async () => choose("/downloads/stale.txt"));
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("starts no download when its destination picker is cancelled or its source changes", async () => {
    useRemote();
    vi.mocked(nativeDialog.open).mockResolvedValueOnce(null);
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await act(async () => toolbar("Download file or folder").click());
    expect(api.transferFiles).not.toHaveBeenCalled();
    let finish!: (value: string) => void;
    vi.mocked(nativeDialog.open).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    act(() => toolbar("Download file or folder").click());
    await act(async () => useStore.setState({ tabs: [], activeId: null }));
    await act(async () => finish("/downloads"));
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("hands every selected local path to the native drag without collapsing the group", async () => {
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await drag("file10.txt");
    expect(api.startFileDrag).toHaveBeenCalledWith(["/selection/folder", "/selection/file10.txt"], expect.any(Function));
    expect(chosen()).toEqual(["folder", "file10.txt"]);
  });

  it("stages every selected remote path before handing the complete group to the native drag", async () => {
    useRemote();
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await drag("file10.txt");
    expect(api.transferFiles).toHaveBeenCalledWith("selection-ssh", [
      { local: "/staging/folder", remote: "/selection/folder", upload: false, directory: true },
      { local: "/staging/file10.txt", remote: "/selection/file10.txt", upload: false, directory: false },
    ], expect.any(Function), expect.any(String));
    expect(api.startFileDrag).toHaveBeenCalledWith(["/staging/folder", "/staging/file10.txt"], expect.any(Function));
  });

  it("cancels a remote group released during staging without handing partial files to the system", async () => {
    useRemote();
    let reject!: (error: Error) => void;
    vi.mocked(api.transferFiles).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await drag("file10.txt");
    const transferId = vi.mocked(api.transferFiles).mock.calls[0][3];
    act(() => window.dispatchEvent(new Event("pointerup")));
    expect(api.cancelTransfer).toHaveBeenCalledWith(transferId);
    await act(async () => reject(Error("transfer cancelled")));
    expect(api.startFileDrag).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Cancelled");
  });

describe("Filer state surfaces", () => {
  it("shows a failed listing as an error with a retry, not as an empty folder", async () => {
    let fail = true;
    vi.mocked(api.localList).mockImplementation(async (path) => {
      if (fail) throw Error("permission denied");
      return { path, entries };
    });
    await mount();
    await act(async () => {});
    const error = host.querySelector<HTMLElement>(".panel-empty.is-error")!;
    expect(error.textContent).toContain("permission denied");
    expect(host.querySelector(".panel-empty-action")!.textContent).toBe("Retry");
    fail = false;
    await act(async () => error.querySelector<HTMLButtonElement>(".panel-empty-action")!.click());
    await act(async () => {});
    expect(host.querySelectorAll(".filer-entry")).toHaveLength(entries.length);
    expect(host.querySelector(".panel-empty.is-error")).toBeNull();
  });

  it("names an empty folder instead of rendering a blank list", async () => {
    vi.mocked(api.localList).mockResolvedValue({ path: "/selection", entries: [] });
    await mount();
    await act(async () => {});
    expect(host.querySelector(".panel-empty")?.textContent).toBe("This folder is empty.");
  });
});

describe("Filer transfer failure recovery", () => {
  /** Picks one local file and uploads it; settles once the attempt is over. */
  const startUpload = async () => {
    vi.mocked(nativeDialog.open).mockResolvedValue(["/local/notes.txt"]);
    await act(async () => { toolbar("Upload files or folders").click(); });
    await act(async () => { menuItem("Upload Files…").click(); });
    await act(async () => {});
  };

  it("keeps a failed upload in the footer and retries it into the same folder", async () => {
    useRemote();
    let attempts = 0;
    vi.mocked(api.transferFiles).mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw Error("connection lost");
    });
    await mount();
    await startUpload();
    expect(attempts).toBe(1);
    expect(host.querySelector<HTMLElement>(".filer-transfer.is-error")!.textContent)
      .toContain("Upload failed");
    const retry = host.querySelector<HTMLButtonElement>(".filer-transfer-retry")!;
    expect(retry).not.toBeNull();
    await act(async () => { retry.click(); });
    await act(async () => {});
    expect(attempts).toBe(2);
    expect(vi.mocked(api.transferFiles).mock.calls[1][1]).toEqual([
      { local: "/local/notes.txt", remote: "/selection/notes.txt", upload: true },
    ]);
    expect(host.querySelector(".filer-transfer.is-error")).toBeNull();
  });

  // A progressbar is a children-presentational role: while the bar was the
  // footer's outer element, the cancel and retry buttons inside it were left
  // out of the accessibility tree and a keyboard user could not reach "cancel"
  // at all. jsdom has no accessibility tree to ask, so this pins the structure
  // instead — the role is on the track, and no button lives under it.
  it("leaves the footer's buttons outside the progressbar", async () => {
    useRemote();
    vi.mocked(api.transferFiles).mockImplementation(async () => new Promise(() => {}));
    await mount();
    await startUpload();
    const bar = host.querySelector<HTMLElement>(".filer-transfer-track")!;
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(host.querySelector(".filer-transfer")!.getAttribute("role")).toBeNull();
    expect(bar.querySelectorAll("button").length).toBe(0);
    const cancel = host.querySelector<HTMLElement>(".filer-transfer-cancel")!;
    expect(cancel.getAttribute("role")).toBeNull();
    expect(bar.contains(cancel)).toBe(false);
    expect(host.querySelector(".filer-transfer")!.contains(cancel)).toBe(true);
  });

  it("reruns a failed upload from the error line's Retry instead of only reloading", async () => {
    useRemote();
    let attempts = 0;
    vi.mocked(api.transferFiles).mockImplementation(async () => {
      attempts += 1;
      throw Error("connection lost");
    });
    await mount();
    await startUpload();
    expect(attempts).toBe(1);
    const retry = host.querySelector<HTMLButtonElement>(
      ".panel-empty.is-error .panel-empty-action",
    )!;
    expect(retry.textContent).toBe("Retry");
    await act(async () => { retry.click(); });
    await act(async () => {});
    expect(attempts).toBe(2);
  });
});

describe("Filer browsing surfaces", () => {
  it("shows a size column and sorts by it the way the dual-pane rows do", async () => {
    const sized = entries.map((entry, index) => ({ ...entry, size: [30, 10, 20, 0][index] }));
    vi.mocked(api.localList).mockResolvedValue({ path: "/selection", entries: sized });
    await mount();
    await act(async () => {});
    const size = (name: string) => row(name).querySelector(".filer-col-size")!.textContent;
    expect(size("file10.txt")).toBe("30 B");
    // A folder has no size of its own, and an empty cell is read as nothing,
    // which is what an absent size is. A dash would read as a small number.
    expect(size("folder")).toBe("");
    // Captions carry no aria-label: their own text is their accessible name
    // now, the state travels as aria-sort, and data-sort-key is the handle.
    const caption = host.querySelector<HTMLButtonElement>('.filer-columns [data-sort-key="size"]')!;
    expect(caption.getAttribute("aria-sort")).toBe("none");
    await act(async () => { caption.click(); });
    expect(caption.getAttribute("aria-sort")).toBe("ascending");
    await act(async () => { caption.click(); });
    expect(caption.getAttribute("aria-sort")).toBe("descending");
    expect(rows().map((element) => element.querySelector(".row-label")!.textContent))
      .toEqual(["folder", "file10.txt", "file3.txt", "file2.txt"]);
  });

  it("opens the home folder from the path row", async () => {
    await mount();
    await act(async () => {});
    vi.mocked(api.localHome).mockResolvedValue("/home/tester");
    const listed: string[] = [];
    vi.mocked(api.localList).mockImplementation(async (path) => {
      listed.push(path);
      return { path, entries };
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.filer-path [aria-label="Home folder"]')!.click();
    });
    await act(async () => {});
    expect(listed[listed.length - 1]).toBe("/home/tester");
    expect(host.querySelector<HTMLInputElement>(".filer-path input")!.value).toBe("/home/tester");
  });

  it("offers every ancestor of the open folder and navigates to the clicked one", async () => {
    const listed: string[] = [];
    vi.mocked(api.localList).mockImplementation(async (path) => {
      listed.push(path);
      return { path, entries };
    });
    await mount();
    await act(async () => {});
    const crumbs = () => [...host.querySelectorAll<HTMLElement>(".filer-crumb")]
      .map((crumb) => crumb.textContent);
    expect(crumbs()).toEqual(["/", "selection"]);
    await act(async () => { host.querySelectorAll<HTMLButtonElement>(".filer-crumb")[0].click(); });
    await act(async () => {});
    expect(listed[listed.length - 1]).toBe("/");
    expect(crumbs()).toEqual(["/"]);
  });

  it("splits a Windows path into drive and folders and titles each full target", async () => {
    vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries }));
    await mount();
    await act(async () => {});
    const input = host.querySelector<HTMLInputElement>(".filer-path input")!;
    type(input, "C:\\Users\\me");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => {});
    const crumbs = [...host.querySelectorAll<HTMLElement>(".filer-crumb")];
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["C:", "Users", "me"]);
    expect(crumbs.map((crumb) => crumb.getAttribute("title")))
      .toEqual(["C:", "C:\\Users", "C:\\Users\\me"]);
  });

  it("draws no trail at the drives root and keeps Delete refused there", async () => {
    vi.mocked(api.localHome).mockResolvedValue(api.LOCAL_DRIVES_ROOT);
    await mount();
    await act(async () => {});
    expect(host.querySelector(".filer-breadcrumbs")).toBeNull();
    press("file10.txt");
    act(() => host.querySelector<HTMLElement>(".filer-list")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.localRemove).not.toHaveBeenCalled();
  });

  it("removes the selection with the Delete key through the same confirmation", async () => {
    await mount();
    press("file10.txt"); press("file3.txt", { ctrlKey: true });
    act(() => host.querySelector<HTMLElement>(".filer-list")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    const dialog = host.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("2 selected items");
    expect(api.localRemove).not.toHaveBeenCalled();
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!.click());
    expect(api.localRemove).not.toHaveBeenCalled();
  });
});

describe("Filer rename", () => {
  const editor = () => host.querySelector<HTMLInputElement>(".filer-new-entry input");
  const list = () => host.querySelector<HTMLElement>(".filer-list")!;
  /** A full press-and-release, the way a real click arrives. The group a
   *  second click collapses is decided on the release, not the press. */
  const click = (name: string, options: MouseEventInit = {}) => act(() => {
    const element = row(name);
    element.setPointerCapture = vi.fn();
    element.hasPointerCapture = () => false;
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ...options }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...options }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, ...options }));
  });

  for (const remote of [false, true]) it(`renames the focused ${remote ? "remote" : "local"} entry in place`, async () => {
    if (remote) useRemote();
    await mount();
    press("file2.txt");
    act(() => list().dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
    const input = editor()!;
    expect(input.value).toBe("file2.txt");
    type(input, "renamed.txt");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    if (remote) {
      expect(api.sftpRename).toHaveBeenCalledWith(
        "selection-ssh", "/selection/file2.txt", "/selection/renamed.txt",
      );
    } else {
      expect(api.localRename).toHaveBeenCalledWith(
        "/selection/file2.txt", "/selection/renamed.txt",
      );
    }
    expect(editor()).toBeNull();
  });

  it("renames from the toolbar and the context menu, one entry at a time", async () => {
    await mount();
    expect(renameButton().disabled).toBe(true);
    click("file2.txt");
    expect(renameButton().disabled).toBe(false);
    press("file3.txt", { ctrlKey: true });
    expect(renameButton().disabled).toBe(true);
    // A plain press on a row that is already part of a group keeps the group,
    // so the gesture that starts a group drag cannot shrink it; the release
    // that follows collapses it to that row.
    click("file2.txt");
    expect(renameButton().disabled).toBe(false);
    await act(async () => { renameButton().click(); });
    expect(editor()!.value).toBe("file2.txt");
    act(() => editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(editor()).toBeNull();
    context("file3.txt");
    await act(async () => { renameMenuItem().click(); });
    expect(editor()!.value).toBe("file3.txt");
    type(editor()!, "notes.md");
    await act(async () => editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.localRename).toHaveBeenCalledWith("/selection/file3.txt", "/selection/notes.md");
  });

  it("keeps the editor open on a rejected name and closes it on Escape", async () => {
    await mount();
    press("file2.txt");
    act(() => list().dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
    const input = editor()!;
    type(input, "nested/name.txt");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.localRename).not.toHaveBeenCalled();
    expect(editor()!.value).toBe("nested/name.txt");
    expect(host.querySelector(".panel-empty.is-error")!.textContent).toContain("not a valid");
    type(input, "file3.txt");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.localRename).not.toHaveBeenCalled();
    expect(editor()!.value).toBe("file3.txt");
    expect(host.querySelector(".panel-empty.is-error")!.textContent).toContain("already exists");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(editor()).toBeNull();
    expect(api.localRename).not.toHaveBeenCalled();
  });
});

describe("Filer keyboard navigation", () => {
  /** Every label the open context menu carries, in document order. */
  const menuLabels = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (element) => element.textContent?.trim(),
    );
  /** A key press on the listbox itself, the way a focused list receives it. */
  const key = (name: string, options: KeyboardEventInit = {}) =>
    act(() => {
      host.querySelector<HTMLElement>(".filer-list")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, ...options }),
      );
    });
  /** Dismisses an open menu the way clicking anywhere outside it does. */
  const dismissMenu = () => act(() => {
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

  it("opens the one selected entry with Enter even when no keyboard cursor is set", async () => {
    await mount();
    // A right-click selects a row without moving the keyboard cursor, and Enter
    // used to act on the cursor alone — so this selection opened nothing.
    context("folder");
    expect(chosen()).toEqual(["folder"]);
    key("Enter");
    expect(vi.mocked(api.localList).mock.calls.map((call) => call[0])).toContain(
      "/selection/folder",
    );
  });

  it("clears the selection with Escape while a delete is still running", async () => {
    const pending: (() => void)[] = [];
    vi.mocked(api.localRemove).mockImplementation(
      () => new Promise<void>((resolve) => { pending.push(resolve); }),
    );
    await mount();
    press("file10.txt");
    press("folder", { ctrlKey: true });
    act(() => toolbar("Delete").click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click();
    });
    expect(chosen()).toHaveLength(2);
    // `busy` gates every other key; Escape used to be gated too, which left the
    // user holding a selection they could not take back for the whole delete.
    key("Escape");
    expect(chosen()).toEqual([]);
    await act(async () => { pending.forEach((resolve) => resolve()); });
  });

  it("opens the row menu with the menu key and with Shift+F10", async () => {
    await mount();
    press("file2.txt");
    key("ContextMenu");
    expect(menuLabels()).toContain("Copy Path");
    dismissMenu();
    key("F10", { shiftKey: true });
    expect(menuLabels()).toContain("Copy Path");
    dismissMenu();
  });

  it("opens the folder menu with the menu key in an empty folder", async () => {
    vi.mocked(api.localList).mockResolvedValue({ path: "/selection", entries: [] });
    await mount();
    await act(async () => {});
    expect(host.querySelector(".panel-empty")?.textContent).toBe("This folder is empty.");
    // The menu key is answered before the empty-list check, because the
    // folder's own menu is all an empty folder has to offer.
    key("ContextMenu");
    expect(menuLabels()).toContain("New File…");
    dismissMenu();
  });

  it("closes the inline create draft when the directory changes", async () => {
    await mount();
    await act(async () => {});
    act(() => toolbar("New file").click());
    expect(host.querySelector(".filer-new-entry")).not.toBeNull();
    // An empty draft has nothing to commit, so its own blur leaves it open —
    // and it used to ride along into the next directory, where committing it
    // would have named the entry into a folder it was never typed for.
    vi.mocked(api.localHome).mockResolvedValue("/home/tester");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.filer-path [aria-label="Home folder"]')!.click();
    });
    await act(async () => {});
    expect(host.querySelector(".filer-new-entry")).toBeNull();
    expect(host.querySelector<HTMLInputElement>(".filer-path input")!.value).toBe("/home/tester");
  });
});
});
