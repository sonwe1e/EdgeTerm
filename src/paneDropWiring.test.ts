import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("./components/FileIcon", () => ({ FileIcon: () => null }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  sftpHome: vi.fn(),
  sftpList: vi.fn(),
  localHome: vi.fn(),
  localList: vi.fn(),
  sftpUpload: vi.fn(),
  sftpUploadDirectory: vi.fn(),
  sftpDownload: vi.fn(),
  sftpDownloadDirectory: vi.fn(),
  compareFiles: vi.fn(),
  cancelFileDiff: vi.fn(),
}));

import * as api from "./api";
import { FtpPane } from "./components/FtpPane";
import type { Tab } from "./store";
import type { FileEntry } from "./types";

const entry = (dir: string, name: string, isDir = false): FileEntry => ({
  path: `${dir}/${name}`, name, isDir, isSymlink: false,
  size: 10, modified: 1, permissions: null, owner: null, group: null,
});

const remoteEntries = [entry("/remote", "folder", true), entry("/remote", "a.txt")];
const localEntries = [entry("/local", "folder2", true), entry("/local", "up.txt")];

const tab: Tab = {
  info: {
    id: "sftp1",
    profileId: "sftp1",
    name: "sftp1",
    kind: "sftp",
    protocol: "sftp",
    address: "host:22",
    color: "#4ea1f3",
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "sftp1", name: "sftp1", kind: "sftp" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: "pane",
};

let host: HTMLDivElement;
let root: Root;
let under: Element | null = null;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  // jsdom has no layout, so what sits under the pointer is stated by the test.
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => under,
  });
  vi.mocked(api.sftpHome).mockResolvedValue("/remote");
  vi.mocked(api.localHome).mockResolvedValue("/local");
  vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({ path, entries: remoteEntries }));
  vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries: localEntries }));
  vi.mocked(api.sftpUpload).mockResolvedValue(undefined);
  vi.mocked(api.sftpUploadDirectory).mockResolvedValue(undefined);
  vi.mocked(api.sftpDownload).mockResolvedValue(undefined);
  vi.mocked(api.sftpDownloadDirectory).mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(FtpPane, { tab, active: true })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  under = null;
});

const row = (path: string) => host.querySelector<HTMLElement>(`[role=option][title="${path}"]`)!;
const list = (label: string) => host.querySelector<HTMLElement>(`[role=listbox][aria-label="${label}"]`)!;

/** Presses `from`, drags it far enough to count, and releases over `to`. */
async function drag(from: HTMLElement, to: Element) {
  from.setPointerCapture = () => {};
  under = to;
  await act(async () => {
    from.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    from.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    from.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
  });
}

const transfers = () => [
  api.sftpUpload, api.sftpUploadDirectory, api.sftpDownload, api.sftpDownloadDirectory,
].flatMap((fn) => vi.mocked(fn).mock.calls);

describe("dragging between and within the dual panes, through FtpPane", () => {
  it("compares only a selected file on each side through the dialog IPC", async () => {
    const compare = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Compare")!;
    vi.mocked(api.compareFiles).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.cancelFileDiff).mockResolvedValue(undefined);
    expect(compare().disabled).toBe(true);
    await act(async () => row("/remote/folder").click());
    await act(async () => row("/local/up.txt").click());
    expect(compare().disabled).toBe(true);
    await act(async () => row("/remote/a.txt").click());
    expect(compare().disabled).toBe(false);
    await act(async () => compare().click());
    expect(api.compareFiles).toHaveBeenCalledWith("sftp1", expect.any(String), "/local/up.txt", "/remote/a.txt");
    const id = vi.mocked(api.compareFiles).mock.calls[0][1];
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close file comparison"]')!.click());
    expect(api.cancelFileDiff).toHaveBeenCalledWith(id);
  });
  it("uploads a local file dropped on the remote list (the harness works)", async () => {
    expect(row("/local/up.txt")).not.toBeNull();
    await drag(row("/local/up.txt"), list("SFTP Server file list"));
    expect(api.sftpUpload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.sftpUpload).mock.calls[0].slice(0, 3)).toEqual([
      "sftp1", "/local/up.txt", "/remote/up.txt",
    ]);
  });

  it("downloads a remote file dropped on the local list", async () => {
    await drag(row("/remote/a.txt"), list("Local Computer file list"));
    expect(api.sftpDownload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.sftpDownload).mock.calls[0].slice(0, 3)).toEqual([
      "sftp1", "/remote/a.txt", "/local/a.txt",
    ]);
  });

  it("does nothing for a remote file dropped on a remote folder or its own list", async () => {
    await drag(row("/remote/a.txt"), row("/remote/folder"));
    await drag(row("/remote/a.txt"), list("SFTP Server file list"));
    expect(transfers()).toEqual([]);
  });

  it("does nothing for a local file dropped on a local folder or its own list", async () => {
    await drag(row("/local/up.txt"), row("/local/folder2"));
    await drag(row("/local/up.txt"), list("Local Computer file list"));
    expect(transfers()).toEqual([]);
  });
});
