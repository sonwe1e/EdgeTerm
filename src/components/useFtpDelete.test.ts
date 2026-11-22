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
  sftpRename: vi.fn(),
  localRename: vi.fn(),
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
  const rename = vi.mocked(side === "remote" ? api.sftpRename : api.localRename);
  let root: ReturnType<typeof createRoot>;
  let directory: ReturnType<typeof useFtpDirectory>;
  let actions: ReturnType<typeof useFtpActions>;
  // [path, rows, the listing's error, the operation's notice]. The two are
  // separate: a directory that could not be read replaces the rows with its
  // error, while a delete failure is reported beside the rows a reload
  // returned.
  const shown = () =>
    side === "remote"
      ? [
          directory.remotePath,
          directory.remoteEntries,
          directory.remoteError,
          directory.remoteNotice,
        ]
      : [directory.localPath, directory.localEntries, directory.localError, directory.localNotice];
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

  it("refreshes after partial deletion without hiding the failure or deleting later entries", async () => {
    remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("cannot delete b"));
    list.mockResolvedValueOnce({ path, entries: entries.slice(1) });
    await act(async () => deleteEntries(entries));
    expect(remove).toHaveBeenCalledTimes(2);
    // The reloaded rows are kept and the failure sits beside them, not in the
    // listing's error line, which would hide them.
    expect(shown()).toEqual([path, entries.slice(1), null, "cannot delete b"]);
  });

  it("reports the delete failure even when the refresh also fails", async () => {
    remove.mockRejectedValueOnce(new Error("cannot delete a"));
    list.mockRejectedValueOnce(new Error("cannot list"));
    await act(async () => deleteEntries(entries));
    expect(list).toHaveBeenCalledTimes(2);
    // Nothing was read, so the read's error replaces the rows; the operation
    // that prompted the reload is still reported beside it.
    expect(shown()).toEqual([path, entries, "cannot list", "cannot delete a"]);
  });

  it("shows the refresh error if deletion succeeded", async () => {
    remove.mockResolvedValue(undefined);
    list.mockRejectedValueOnce(new Error("cannot list"));
    await act(async () => deleteEntries(entries));
    expect(shown()).toEqual([path, entries, "cannot list", null]);
  });

  it("refreshes after successful deletion without an error", async () => {
    remove.mockResolvedValue(undefined);
    list.mockResolvedValueOnce({ path, entries: [] });
    await act(async () => deleteEntries(entries));
    expect(shown()).toEqual([path, [], null, null]);
  });

  it("does not delete or refresh if single-entry confirmation is canceled", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    await act(async () => deleteEntries(entries.slice(0, 1)));
    expect(ask).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
    expect(shown()).toEqual([path, entries, null, null]);
  });

  it("reports the failure on the newer view instead of refreshing the old directory", async () => {
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
    // The directory the removal left is not reloaded over the newer one, and
    // the failure the user has to hear about is reported on the view they are
    // looking at rather than dropped with the old listing.
    expect(list).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(["/next", [], null, "old-directory failure"]);
  });

  it("clears the failure when the next removal starts", async () => {
    remove.mockRejectedValueOnce(new Error("cannot delete a"));
    await act(async () => deleteEntries(entries));
    expect(shown()[3]).toBe("cannot delete a");

    remove.mockResolvedValue(undefined);
    list.mockResolvedValueOnce({ path, entries: entries.slice(1) });
    await act(async () => deleteEntries(entries));
    // The confirmed attempt replaced the last failure instead of leaving it
    // over rows it no longer describes.
    expect(shown()).toEqual([path, entries.slice(1), null, null]);
  });

  it("clears the failure when a rename starts and the pane does not reload", async () => {
    remove.mockRejectedValueOnce(new Error("cannot delete a"));
    await act(async () => deleteEntries(entries));
    expect(shown()[3]).toBe("cannot delete a");

    // A rename that throws reports into its own dialog and never reloads, so
    // the stale notice has to go when the operation starts.
    rename.mockRejectedValueOnce(new Error("cannot rename a"));
    const renameFirst = () => actions.renameRemote("z", entries[0]);
    const renameFirstLocal = () => actions.renameLocal("z", entries[0]);
    await act(async () => {
      await expect(side === "remote" ? renameFirst() : renameFirstLocal()).rejects.toThrow(
        "cannot rename a",
      );
    });
    expect(shown()).toEqual([path, entries, null, null]);
  });

  it("clears the failure when the pane navigates", async () => {
    remove.mockRejectedValueOnce(new Error("cannot delete a"));
    await act(async () => deleteEntries(entries));
    expect(shown()[3]).toBe("cannot delete a");

    list.mockResolvedValueOnce({ path: "/next", entries: [] });
    await act(async () => {
      await navigate("/next");
    });
    expect(shown()).toEqual(["/next", [], null, null]);
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
    expect(shown()).toEqual([path, entries, null, null]);

    list.mockResolvedValueOnce({ path, entries: [] });
    await act(async () => {
      deletion.resolve(undefined);
      await pending;
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(shown()).toEqual([path, [], null, null]);
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
      expect(shown()).toEqual([path, entries, null, null]);

      await act(async () => {
        list.mockResolvedValueOnce({ path, entries: entries.slice(1) });
        if (succeeds) navigation.resolve({ path: "/next", entries: [] });
        else navigation.reject(new Error("cannot open /next"));
        await navigating;
        await deleting;
      });
      // Either way the newer navigation is not overridden; the failure it
      // jumped over is reported on whichever view remains.
      expect(list).toHaveBeenCalledTimes(succeeds ? 2 : 3);
      expect(shown()).toEqual(
        succeeds
          ? ["/next", [], null, "cannot delete b"]
          : [path, entries.slice(1), null, "cannot delete b"],
      );
    },
  );
});
