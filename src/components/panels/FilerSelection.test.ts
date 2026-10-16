import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("../../platform", () => ({ get IS_MAC() { return platform.mac; }, get IS_WINDOWS() { return !platform.mac; } }));
vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../../actions", () => ({ revealCwdInFiler: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../nativeDialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../api", async (original) => ({
  ...await original<typeof import("../../api")>(),
  localHome: vi.fn(), localList: vi.fn(), localRemove: vi.fn(), sftpRemove: vi.fn(),
  sftpHome: vi.fn(), sftpList: vi.fn(), transferFiles: vi.fn(), startFileDrag: vi.fn(),
  dragStagingPath: vi.fn(), cancelTransfer: vi.fn(),
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
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(api.localHome).mockResolvedValue("/selection");
  vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries }));
  vi.mocked(api.sftpHome).mockResolvedValue("/selection");
  vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({ path, entries }));
  vi.mocked(api.localRemove).mockResolvedValue();
  vi.mocked(api.sftpRemove).mockResolvedValue();
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


describe("Filer multiple selection at the real panel entry", () => {
  it("adds and toggles paths with Ctrl instead of replacing the selection", async () => {
    await mount();
    press("file10.txt");
    press("file3.txt", { ctrlKey: true });
    expect(chosen()).toEqual(["file10.txt", "file3.txt"]);
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
    press("file10.txt"); press("file3.txt", { shiftKey: true });
    expect(chosen()).toEqual(["file10.txt", "file2.txt", "file3.txt"]);
    act(() => useStore.getState().setFilerSort({ key: "name", direction: "asc", explicit: true }));
    expect(chosen()).toEqual(["file2.txt", "file3.txt", "file10.txt"]);
    press("folder"); press("file3.txt", { shiftKey: true });
    expect(chosen()).toEqual(["folder", "file2.txt", "file3.txt"]);
  });

  it("uses Command for additive selection on macOS", async () => {
    platform.mac = true;
    await mount();
    press("file10.txt"); press("file3.txt", { metaKey: true });
    expect(chosen()).toEqual(["file10.txt", "file3.txt"]);
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
    expect(chosen()).toEqual(["file10.txt", "file3.txt"]);
    await act(async () => menuItem("Copy Path").click());
    expect(write).toHaveBeenCalledWith("/selection/file10.txt\n/selection/file3.txt");
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
        ["selection-ssh", "/selection/file10.txt", false], ["selection-ssh", "/selection/folder", true],
      ]);
    } else {
      expect(vi.mocked(api.localRemove).mock.calls).toEqual([["/selection/file10.txt", false], ["/selection/folder", true]]);
    }
    expect(chosen()).toEqual([]);
  });

  it("keeps failed deletions selected, reports errors, and continues the other selected items", async () => {
    const removed = new Set<string>();
    vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries: entries.filter((entry) => !removed.has(entry.path)) }));
    vi.mocked(api.localRemove).mockImplementation(async (path) => {
      if (path.endsWith("file2.txt")) throw Error("permission denied");
      removed.add(path);
    });
    await mount();
    press("file10.txt"); press("file3.txt", { shiftKey: true });
    act(() => toolbar("Delete").click());
    await act(async () => host.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click());
    expect(api.localRemove).toHaveBeenCalledTimes(3);
    expect(chosen()).toEqual(["file2.txt"]);
    expect(host.textContent).toContain("file2.txt: Error: permission denied");
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
      { local: "/downloads/file10.txt", remote: "/selection/file10.txt", upload: false, directory: false },
      { local: "/downloads/folder", remote: "/selection/folder", upload: false, directory: true },
    ], expect.any(Function), expect.any(String));
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
    expect(api.startFileDrag).toHaveBeenCalledWith(["/selection/file10.txt", "/selection/folder"], expect.any(Function));
    expect(chosen()).toEqual(["file10.txt", "folder"]);
  });

  it("stages every selected remote path before handing the complete group to the native drag", async () => {
    useRemote();
    await mount();
    press("file10.txt"); press("folder", { ctrlKey: true });
    await drag("file10.txt");
    expect(api.transferFiles).toHaveBeenCalledWith("selection-ssh", [
      { local: "/staging/file10.txt", remote: "/selection/file10.txt", upload: false, directory: false },
      { local: "/staging/folder", remote: "/selection/folder", upload: false, directory: true },
    ], expect.any(Function), expect.any(String));
    expect(api.startFileDrag).toHaveBeenCalledWith(["/staging/file10.txt", "/staging/folder"], expect.any(Function));
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
});
