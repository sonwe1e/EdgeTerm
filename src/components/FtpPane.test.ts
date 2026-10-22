// The dual-pane browser was single-selection (upstream issue #101): one entry
// at a time meant one transfer at a time, and a right click collapsed the row
// it landed on. This mounts the real pane over mocked IPC and proves the
// wiring: Ctrl/Shift build a group, the transfer rail sends the whole group in
// one queue job after a single conflict check, the delete dialog removes every
// selected entry, and a single-entry delete keeps the confirmation it had.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../nativeDialog", () => ({
  ask: vi.fn(async () => true),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../actions", () => ({ reconnectSession: vi.fn() }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  sftpHome: vi.fn(),
  sftpList: vi.fn(),
  localHome: vi.fn(),
  localList: vi.fn(),
  localParent: vi.fn(),
  transferFiles: vi.fn(),
  newTransferId: vi.fn(() => "queue-1"),
  sftpRemove: vi.fn(),
  localRemove: vi.fn(),
  sftpRename: vi.fn(),
  localRename: vi.fn(),
  sftpMkdir: vi.fn(),
  localMkdir: vi.fn(),
  cancelTransfer: vi.fn(),
  controlFileTransfer: vi.fn(),
  startFileDrag: vi.fn(),
  onRemoteEditState: async () => () => {},
}));

import * as api from "../api";
import * as nativeDialog from "../nativeDialog";
import { useFileTransfers } from "../fileTransfers";
import { useStore, type Tab } from "../store";
import type { FileEntry } from "../types";
import { FtpPane } from "./FtpPane";

const initialState = useStore.getState();

const file = (base: string, name: string, isDir = false): FileEntry => ({
  name,
  path: `${base}/${name}`,
  isDir,
  isSymlink: false,
  size: 100,
  modified: 1700000000,
  permissions: null,
  owner: null,
  group: null,
});
const remoteFiles = () => [file("/remote", "conf", true), file("/remote", "app.log")];
const localFiles = () => [
  file("/local", "photos", true),
  file("/local", "app.log"),
  file("/local", "notes.txt"),
];

const tab = (): Tab => ({
  info: {
    id: "ftp-session",
    profileId: null,
    name: "ftp-session",
    kind: "sftp",
    protocol: "sftp",
    address: "files.example:22",
    color: "",
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "ftp-session", name: "ftp-session", kind: "sftp" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initialState.activePaneId,
});

let host: HTMLDivElement;
let root: Root;

/** The browser panes are [remote, local], in the order FtpPane renders them. */
const listAt = (index: number) =>
  host.querySelectorAll<HTMLElement>(".ftp-file-browser")[index]!
    .querySelector<HTMLElement>('[role="listbox"]')!;
const rowAt = (index: number, name: string) =>
  [...listAt(index).querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.querySelector(".ftp-file-name > span:last-child")?.textContent === name,
  )!;
const selectedNames = (index: number) =>
  [...listAt(index).querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')].map(
    (row) => row.querySelector(".ftp-file-name > span:last-child")!.textContent,
  );
const clickRow = (index: number, name: string, init: MouseEventInit = {}) =>
  act(() => {
    rowAt(index, name).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  });
const toolbarButton = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const railButton = (title: string) =>
  host.querySelector<HTMLButtonElement>(`.ftp-transfer-button[title="${title}"]`)!;
const menuEntries = () => [
  ...host.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]'),
];
const alertDialog = () => host.querySelector<HTMLElement>('[role="alertdialog"]');
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const mount = async () => {
  await act(async () => {
    root.render(h(FtpPane, { tab: tab(), active: true }));
  });
  // The directory hooks resolve their home directories and first listings
  // through a couple of chained promises; two turns of the event loop settle
  // both panes.
  await flush();
  await flush();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en" }, true);
  useStore.getState().setLanguage("en");
  useFileTransfers.setState({ jobs: {}, open: false });
  vi.mocked(api.sftpHome).mockResolvedValue("/remote");
  vi.mocked(api.localHome).mockResolvedValue("/local");
  vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({
    path,
    entries: path === "/remote" ? remoteFiles() : [],
  }));
  vi.mocked(api.localList).mockImplementation(async (path) => ({
    path,
    entries: path === "/local" ? localFiles() : [],
  }));
  vi.mocked(api.transferFiles).mockResolvedValue(undefined);
  vi.mocked(api.newTransferId).mockReturnValue("queue-1");
  vi.mocked(api.sftpRemove).mockResolvedValue(undefined);
  vi.mocked(api.localRemove).mockResolvedValue(undefined);
  vi.mocked(nativeDialog.ask).mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  vi.restoreAllMocks();
});

describe("FTP/SFTP dual-pane multi-selection and batch transfers", () => {
  it("uploads every selected local entry in one queue job, then reloads", async () => {
    await mount();
    clickRow(1, "app.log");
    clickRow(1, "notes.txt", { ctrlKey: true });
    expect(selectedNames(1)).toEqual(["app.log", "notes.txt"]);

    await act(async () => {
      railButton("Upload selected local file or folder").click();
    });
    await flush();

    expect(api.transferFiles).toHaveBeenCalledTimes(1);
    const [session, items, , queue] = vi.mocked(api.transferFiles).mock.calls[0];
    expect(session).toBe("ftp-session");
    expect(items).toEqual([
      { local: "/local/app.log", remote: "/remote/app.log", upload: true, directory: false },
      { local: "/local/notes.txt", remote: "/remote/notes.txt", upload: true, directory: false },
    ]);
    // One queue job, not one per entry: the transfer center counts files.
    expect(queue).toBe("queue-1");
    // The destination was reloaded after the batch landed.
    expect(
      vi.mocked(api.sftpList).mock.calls.filter(([, path]) => path === "/remote").length,
    ).toBe(2);
    expect(host.textContent).toContain("2 items");
  });

  it("downloads every selected remote entry in one queue job", async () => {
    await mount();
    clickRow(0, "app.log");
    clickRow(0, "conf", { ctrlKey: true });
    expect(selectedNames(0)).toEqual(["conf", "app.log"]);

    await act(async () => {
      railButton("Download selected SFTP file or folder").click();
    });
    await flush();
    // The local folder already holds app.log, so the replace gate asked once
    // for the batch before anything was sent.
    expect(nativeDialog.ask).toHaveBeenCalledTimes(1);
    expect(api.transferFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transferFiles).mock.calls[0][1]).toEqual([
      { local: "/local/conf", remote: "/remote/conf", upload: false, directory: true },
      { local: "/local/app.log", remote: "/remote/app.log", upload: false, directory: false },
    ]);
  });

  it("confirms replacing same-name entries once, and starts nothing when declined", async () => {
    vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({
      path,
      entries:
        path === "/remote"
          ? [file("/remote", "conf", true), file("/remote", "notes.txt")]
          : [],
    }));
    vi.mocked(nativeDialog.ask).mockResolvedValue(false);
    await mount();
    clickRow(1, "app.log");
    clickRow(1, "notes.txt", { ctrlKey: true });

    await act(async () => {
      railButton("Upload selected local file or folder").click();
    });
    await flush();
    expect(nativeDialog.ask).toHaveBeenCalledWith(
      expect.stringContaining("1 item(s)"),
      expect.objectContaining({ title: "Replace Existing Items" }),
    );
    expect(api.transferFiles).not.toHaveBeenCalled();

    // Confirming the same batch sends all of it.
    vi.mocked(nativeDialog.ask).mockResolvedValue(true);
    await act(async () => {
      railButton("Upload selected local file or folder").click();
    });
    await flush();
    expect(api.transferFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transferFiles).mock.calls[0][1]).toHaveLength(2);
  });

  it("deletes the whole selection through the delete dialog, single delete keeps the native ask", async () => {
    await mount();
    clickRow(0, "app.log");
    clickRow(0, "conf", { ctrlKey: true });
    expect(selectedNames(0)).toEqual(["conf", "app.log"]);

    act(() => toolbarButton("Delete remote item").click());
    const dialog = alertDialog()!;
    expect(dialog.textContent).toContain("Delete 2 items");
    expect(dialog.textContent).toContain("/remote/conf");
    expect(dialog.textContent).toContain("/remote/app.log");
    expect(api.sftpRemove).not.toHaveBeenCalled();
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click();
    });
    await flush();
    expect(vi.mocked(api.sftpRemove).mock.calls).toEqual([
      ["ftp-session", "/remote/conf", true, true],
      ["ftp-session", "/remote/app.log", false, false],
    ]);

    // One entry still goes through the native question it always used.
    clickRow(0, "app.log");
    act(() => toolbarButton("Delete remote item").click());
    expect(alertDialog()).toBeNull();
    await flush();
    expect(nativeDialog.ask).toHaveBeenCalledWith(
      expect.stringContaining("app.log"),
      expect.objectContaining({ title: "Delete Item" }),
    );
    expect(api.sftpRemove).toHaveBeenCalledTimes(3);
  });

  it("right-click keeps the group selection and its menu acts on all of it", async () => {
    await mount();
    clickRow(1, "app.log");
    clickRow(1, "notes.txt", { ctrlKey: true });

    act(() => {
      rowAt(1, "app.log").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    // The clicked row is part of the group, so every entry stays selected.
    expect(selectedNames(1)).toEqual(["app.log", "notes.txt"]);
    const labels = menuEntries().map((entry) => entry.textContent);
    expect(labels).toContain("Upload (2)");
    act(() => {
      menuEntries()
        .find((entry) => entry.textContent === "Delete (2)")!
        .click();
    });
    const dialog = alertDialog()!;
    expect(dialog.textContent).toContain("/local/app.log");
    expect(dialog.textContent).toContain("/local/notes.txt");
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click();
    });
    await flush();
    expect(vi.mocked(api.localRemove).mock.calls).toEqual([
      ["/local/app.log", false, false],
      ["/local/notes.txt", false, false],
    ]);
  });

  it("builds a group with Ctrl and Shift in the real pane", async () => {
    await mount();
    clickRow(1, "app.log");
    clickRow(1, "notes.txt", { ctrlKey: true });
    expect(selectedNames(1)).toEqual(["app.log", "notes.txt"]);

    // Ctrl again drops the row, and Shift spans from the anchor it left.
    clickRow(1, "notes.txt", { ctrlKey: true });
    expect(selectedNames(1)).toEqual(["app.log"]);
    clickRow(1, "photos", { shiftKey: true });
    expect(selectedNames(1)).toEqual(["photos", "app.log", "notes.txt"]);
  });
});
