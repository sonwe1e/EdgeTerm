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

import { translate } from "../i18n";
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
  paneId: initialState.activePaneId,
});

let host: HTMLDivElement;
let root: Root;

/** The browser panes are [remote, local], in the order FtpPane renders them. */
const listAt = (index: number) =>
  host
    .querySelectorAll<HTMLElement>(".ftp-file-browser")
    [index]!.querySelector<HTMLElement>('[role="listbox"]')!;
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

it("takes the keyboard when it becomes the focused pane and focus had fallen away", async () => {
  await act(async () => {
    root.render(h(FtpPane, { tab: tab(), active: true, focused: true }));
  });
  await flush();
  await flush();
  // Closing the terminal tab that was in front leaves focus on the body; the
  // file list is this pane's own entry point, so it takes it back.
  const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
  expect(list).not.toBeNull();
  expect(document.activeElement).toBe(list);
});

it("leaves the keyboard alone when a control already has it", async () => {
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  outside.focus();
  await act(async () => {
    root.render(h(FtpPane, { tab: tab(), active: true, focused: true }));
  });
  await flush();
  await flush();
  expect(document.activeElement).toBe(outside);
  outside.blur();
});

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

it("restores the dual pane's local and remote directories independently", async () => {
  useStore.setState({
    tabs: [{ ...tab(), directories: { filer: "/remote/saved", local: "/local/saved" } }],
  });
  await mount();
  expect(api.sftpList).toHaveBeenCalledWith("ftp-session", "/remote/saved");
  expect(api.localList).toHaveBeenCalledWith("/local/saved");
  expect(useStore.getState().tabs[0].directories).toEqual({
    filer: "/remote/saved",
    local: "/local/saved",
  });
});

it("falls back each missing dual-pane directory to its own home", async () => {
  useStore.setState({
    tabs: [{ ...tab(), directories: { filer: "/remote/gone", local: "/local/gone" } }],
  });
  vi.mocked(api.sftpList).mockRejectedValueOnce(new Error("gone"));
  vi.mocked(api.localList).mockRejectedValueOnce(new Error("gone"));
  await mount();
  expect(useStore.getState().tabs[0].directories).toEqual({ filer: "/remote", local: "/local" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  vi.restoreAllMocks();
});

it("offers no folder creation in a pane that has no directory", async () => {
  // A first listing that fails leaves the pane's path empty. Both folder
  // buttons used to stay enabled and pressing one opened no name prompt at
  // all, which reads as a dead control rather than a refusal.
  vi.mocked(api.localHome).mockRejectedValue(new Error("offline"));
  vi.mocked(api.sftpHome).mockRejectedValue(new Error("offline"));
  await mount();
  expect(toolbarButton(translate("en", "ftp.newRemoteFolder")).disabled).toBe(true);
  expect(toolbarButton(translate("en", "ftp.newLocalFolder")).disabled).toBe(true);
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
    expect(vi.mocked(api.sftpList).mock.calls.filter(([, path]) => path === "/remote").length).toBe(
      2,
    );
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
        path === "/remote" ? [file("/remote", "conf", true), file("/remote", "notes.txt")] : [],
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

describe("local Parent navigation", () => {
  const localBrowser = () => host.querySelectorAll(".ftp-file-browser")[1];
  const localPath = () =>
    localBrowser().querySelector<HTMLInputElement>(".ftp-browser-path input")!;
  const clickParent = () =>
    act(() => {
      localBrowser()
        .querySelector<HTMLButtonElement>('button[aria-label="Parent folder"]')!
        .click();
    });
  const enterPath = (path: string) => {
    const input = localPath();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, path);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  };
  const remembered = () => useStore.getState().tabs[0].directories?.local;
  const visits = () => vi.mocked(api.localList).mock.calls.map(([path]) => path);
  const setup = async () => {
    useStore.setState({ tabs: [tab()] });
    await mount();
  };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("opens and remembers the native Parent normally", async () => {
    vi.mocked(api.localParent).mockResolvedValueOnce("/");
    await setup();
    clickParent();
    await flush();
    expect(api.localParent).toHaveBeenCalledWith("/local");
    expect(visits()).toEqual(["/local", "/"]);
    expect([localPath().value, remembered()]).toEqual(["/", "/"]);
  });

  it.each([true, false])(
    "keeps a newer typed path (Parent settles first=%s)",
    async (parentFirst) => {
      const parent = deferred<string>();
      const typed = deferred<{ path: string; entries: FileEntry[] }>();
      vi.mocked(api.localParent).mockReturnValueOnce(parent.promise);
      await setup();
      vi.mocked(api.localList).mockReturnValueOnce(typed.promise);
      clickParent();
      enterPath("/typed");
      expect(visits()).toEqual(["/local", "/typed"]);
      const finishParent = () => act(async () => parent.resolve("/"));
      if (parentFirst) {
        await finishParent();
        expect(visits()).toEqual(["/local", "/typed"]);
      }
      await act(async () => typed.resolve({ path: "/typed", entries: [] }));
      if (!parentFirst) await finishParent();
      expect(visits()).toEqual(["/local", "/typed"]);
      expect([localPath().value, remembered()]).toEqual(["/typed", "/typed"]);
    },
  );

  it("does not reconcile a completed download over the unresolved Parent navigation", async () => {
    const parent = deferred<string>();
    const download = deferred<void>();
    vi.mocked(api.localParent).mockReturnValueOnce(parent.promise);
    vi.mocked(api.transferFiles).mockReturnValueOnce(download.promise);
    await setup();
    clickRow(0, "conf");
    act(() => railButton("Download selected SFTP file or folder").click());
    await flush();
    expect(api.transferFiles).toHaveBeenCalledOnce();
    clickParent();
    await act(async () => download.resolve(undefined));
    expect(visits()).toEqual(["/local"]);
    await act(async () => parent.resolve("/"));
    expect(visits()).toEqual(["/local", "/"]);
    expect([localPath().value, remembered()]).toEqual(["/", "/"]);
  });

  it("shows a current parent lookup error but never carries a stale one into a newer view", async () => {
    const stale = deferred<string>();
    vi.mocked(api.localParent)
      .mockRejectedValueOnce(new Error("Cannot resolve the parent"))
      .mockReturnValueOnce(stale.promise);
    await setup();
    clickParent();
    await flush();
    // Only the list's own error: an operation's notice above the list shares
    // the message classes but is not what this test is about.
    const error = () =>
      localBrowser().querySelector(".ftp-browser-list > .ftp-browser-message.is-error")
        ?.textContent;
    expect(error()).toBe("Cannot resolve the parent");
    expect(visits()).toEqual(["/local"]);
    clickParent();
    enterPath("/typed");
    await flush();
    await act(async () => stale.reject(new Error("Old parent error")));
    expect(error()).toBeUndefined();
    expect([localPath().value, remembered()]).toEqual(["/typed", "/typed"]);
  });
});

// A delete that fails must tell the user what is left, not replace the list
// it just reloaded (FileBrowser only drew its rows when `error` was null), and
// it must still say so when the pane moved on while the removal ran (the
// refresh had nowhere to report a failure it could not reload into).
describe("FTP/SFTP operation failure feedback", () => {
  const paneAt = (index: number) => host.querySelectorAll<HTMLElement>(".ftp-file-browser")[index]!;
  const rowNames = (index: number) =>
    [...listAt(index).querySelectorAll<HTMLElement>('[role="option"]')].map(
      (row) => row.querySelector(".ftp-file-name > span:last-child")!.textContent,
    );
  const noticeAt = (index: number) =>
    paneAt(index).querySelector(".ftp-browser-notice")?.textContent;
  const listErrorAt = (index: number) =>
    listAt(index).querySelector(".ftp-browser-message.is-error")?.textContent;
  const pathAt = (index: number) =>
    paneAt(index).querySelector<HTMLInputElement>(".ftp-browser-path input")!;
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("keeps the refreshed rows beside a failed delete's message", async () => {
    await mount();
    clickRow(0, "app.log");
    clickRow(0, "conf", { ctrlKey: true });
    expect(selectedNames(0)).toEqual(["conf", "app.log"]);

    // The folder goes and the file does not; the reload lists what is left.
    vi.mocked(api.sftpRemove)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cannot remove app.log"));
    vi.mocked(api.sftpList).mockResolvedValueOnce({
      path: "/remote",
      entries: [file("/remote", "app.log")],
    });
    act(() => toolbarButton("Delete remote item").click());
    const dialog = alertDialog()!;
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>(".confirm-dialog .is-danger")!.click();
    });
    await flush();

    expect(noticeAt(0)).toBe("cannot remove app.log");
    // The refreshed listing is on screen and still usable: the entry whose
    // removal failed is listed and can be selected again.
    expect(rowNames(0)).toEqual(["app.log"]);
    expect(listErrorAt(0)).toBeUndefined();
    clickRow(0, "app.log");
    expect(selectedNames(0)).toEqual(["app.log"]);
  });

  it("reports a delete failure after the pane navigated away", async () => {
    const removal = deferred<void>();
    vi.mocked(api.sftpRemove).mockReturnValueOnce(removal.promise);
    vi.mocked(api.sftpList).mockImplementation(async (_id, path) => ({
      path,
      entries: path === "/remote" ? remoteFiles() : [file(path, "inner.log")],
    }));
    await mount();
    clickRow(0, "app.log");
    act(() => toolbarButton("Delete remote item").click());
    await flush();
    expect(api.sftpRemove).toHaveBeenCalledOnce();

    // The removal is still running when the user opens a folder.
    act(() => {
      rowAt(0, "conf").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await flush();
    expect(pathAt(0).value).toBe("/remote/conf");
    expect(rowNames(0)).toEqual(["inner.log"]);

    await act(async () => {
      removal.reject(new Error("cannot remove app.log"));
    });
    await flush();

    // The failure is reported on the view the user is looking at: the old
    // directory is not reloaded over it, and the new rows stay.
    expect(noticeAt(0)).toBe("cannot remove app.log");
    expect(rowNames(0)).toEqual(["inner.log"]);
    expect(pathAt(0).value).toBe("/remote/conf");
    expect(listErrorAt(0)).toBeUndefined();
  });
});
