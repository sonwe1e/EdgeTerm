import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ask } from "../nativeDialog";
import type { Tab } from "../store";
import type { FileEntry } from "../types";
import { useFtpActions } from "./useFtpActions";
import { useFtpDirectory } from "./useFtpDirectory";

vi.mock("../api", () => ({
  sftpHome: vi.fn(),
  localHome: vi.fn(),
  sftpList: vi.fn(),
  localList: vi.fn(),
  sftpRemove: vi.fn(),
  localRemove: vi.fn(),
}));
vi.mock("../nativeDialog", () => ({ ask: vi.fn() }));

const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const tab: Tab = { state: "connected" } as Tab;
const sessionId = "ftp-delete-test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe.each(["remote", "local"] as const)("%s FTP-pane deletion", (side) => {
  const path = `/${side}`;
  const entry = (name: string): FileEntry => ({
    name,
    path: `${path}/${name}`,
    isDir: false,
    isSymlink: false,
    size: 1,
    modified: null,
    permissions: null,
    owner: null,
    group: null,
  });
  const entries = [entry("a"), entry("b"), entry("c")];
  const list = vi.mocked(side === "remote" ? api.sftpList : api.localList);
  const remove = vi.mocked(side === "remote" ? api.sftpRemove : api.localRemove);
  let root: ReturnType<typeof createRoot>;
  let directory: ReturnType<typeof useFtpDirectory>;
  let actions: ReturnType<typeof useFtpActions>;
  const shown = () =>
    side === "remote"
      ? [directory.remotePath, directory.remoteEntries, directory.remoteError]
      : [directory.localPath, directory.localEntries, directory.localError];
  const deleteEntries = (files: FileEntry[]) =>
    side === "remote" ? actions.removeRemoteEntries(files) : actions.removeLocalEntries(files);
  const navigate = (target: string) =>
    side === "remote" ? directory.loadRemote(target) : directory.loadLocal(target);

  beforeEach(async () => {
    vi.resetAllMocks();
    react.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.sftpHome).mockResolvedValue("/remote");
    vi.mocked(api.localHome).mockResolvedValue("/local");
    vi.mocked(api.sftpList).mockResolvedValue({ path: "/remote", entries: [] });
    vi.mocked(api.localList).mockResolvedValue({ path: "/local", entries: [] });
    list.mockResolvedValue({ path, entries });
    root = createRoot(document.createElement("div"));
    function Harness() {
      directory = useFtpDirectory({ tab, sessionId });
      actions = useFtpActions({ ...directory, sessionId, transferring: false });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    react.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("refreshes after partial deletion without hiding the error or deleting later entries", async () => {
    remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cannot delete b"));
    list.mockResolvedValueOnce({ path, entries: entries.slice(1) });
    await act(async () => deleteEntries(entries));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual([path, entries.slice(1), "cannot delete b"]);
  });

  it("preserves the delete error when the refresh also fails", async () => {
    remove.mockRejectedValueOnce(new Error("cannot delete a"));
    list.mockRejectedValueOnce(new Error("cannot list"));
    await act(async () => deleteEntries(entries));
    expect(list).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual([path, entries, "cannot delete a"]);
  });

  it("shows the refresh error if deletion succeeded", async () => {
    remove.mockResolvedValue(undefined);
    list.mockRejectedValueOnce(new Error("cannot list"));
    await act(async () => deleteEntries(entries));
    expect(shown()).toEqual([path, entries, "cannot list"]);
  });

  it("refreshes after successful deletion without an error", async () => {
    remove.mockResolvedValue(undefined);
    list.mockResolvedValueOnce({ path, entries: [] });
    await act(async () => deleteEntries(entries));
    expect(shown()).toEqual([path, [], null]);
  });

  it("does not delete or refresh if single-entry confirmation is canceled", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    await act(async () => deleteEntries(entries.slice(0, 1)));
    expect(ask).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
    expect(shown()).toEqual([path, entries, null]);
  });

  it("does not refresh the old directory or show its error after newer navigation", async () => {
    const deletion = deferred<void>();
    remove.mockReturnValueOnce(deletion.promise);
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = deleteEntries(entries);
    });
    list.mockResolvedValueOnce({ path: "/next", entries: [] });
    await act(async () => {
      await navigate("/next");
    });
    await act(async () => {
      deletion.reject(new Error("old-directory failure"));
      await pending;
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(["/next", [], null]);
  });

  it("reconciles after a same-directory refresh read pre-delete rows", async () => {
    const deletion = deferred<void>();
    remove.mockReturnValueOnce(deletion.promise).mockResolvedValue(undefined);
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = deleteEntries(entries);
    });
    await act(async () => {
      await navigate(path);
    });
    expect(shown()).toEqual([path, entries, null]);

    list.mockResolvedValueOnce({ path, entries: [] });
    await act(async () => {
      deletion.resolve(undefined);
      await pending;
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(shown()).toEqual([path, [], null]);
  });

  it.each([true, false])(
    "waits for pending different navigation (success=%s)",
    async (succeeds) => {
      const deletion = deferred<void>();
      remove.mockResolvedValueOnce(undefined).mockReturnValueOnce(deletion.promise);
      let deleting: Promise<void> | undefined;
      await act(async () => {
        deleting = deleteEntries(entries);
      });
      const navigation = deferred<{ path: string; entries: FileEntry[] }>();
      list.mockReturnValueOnce(navigation.promise);
      let navigating: Promise<boolean> | undefined;
      await act(async () => {
        navigating = navigate("/next");
      });
      await act(async () => {
        deletion.reject(new Error("cannot delete b"));
      });
      expect(list).toHaveBeenCalledTimes(2);
      expect(shown()).toEqual([path, entries, null]);

      await act(async () => {
        list.mockResolvedValueOnce({ path, entries: entries.slice(1) });
        if (succeeds) navigation.resolve({ path: "/next", entries: [] });
        else navigation.reject(new Error("cannot open /next"));
        await navigating;
        await deleting;
      });
      expect(list).toHaveBeenCalledTimes(succeeds ? 2 : 3);
      expect(shown()).toEqual(
        succeeds ? ["/next", [], null] : [path, entries.slice(1), "cannot delete b"],
      );
    },
  );
});
