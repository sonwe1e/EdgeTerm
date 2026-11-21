import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ask } from "../nativeDialog";
import { useStore, type Tab } from "../store";
import type { FileEntry } from "../types";
import { useFtpDirectory } from "./useFtpDirectory";
import { useFtpTransfer } from "./useFtpTransfer";

vi.mock("../nativeDialog", () => ({ ask: vi.fn() }));

vi.mock("../api", () => ({
  sftpHome: vi.fn(),
  localHome: vi.fn(),
  sftpList: vi.fn(),
  localList: vi.fn(),
  newTransferId: vi.fn(() => "transfer-one"),
  transferFiles: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const sessionId = "ftp-transfer-fixture";
const tab = { state: "connected", info: { id: sessionId } } as Tab;
const file: FileEntry = {
  name: "notes.txt",
  path: "/source/notes.txt",
  size: 1,
  modified: null,
  isDir: false,
  isSymlink: false,
  permissions: null,
  group: null,
  owner: null,
};
const listing = (path: string, entries: FileEntry[] = []) => ({ path, entries });

describe.each(["upload", "download"] as const)("%s completion directory", (direction) => {
  const upload = direction === "upload";
  const initial = upload ? "/remote" : "/local";
  const next = `${initial}-next`;
  const read = vi.mocked(upload ? api.sftpList : api.localList);
  const visits = () => read.mock.calls.map((args) => args[upload ? 1 : 0]);
  let root: ReturnType<typeof createRoot>;
  let oldTabs: Tab[];
  let dirs: ReturnType<typeof useFtpDirectory>;
  let transfer: ReturnType<typeof useFtpTransfer>;
  let outgoing: ReturnType<typeof deferred<void>>;
  let transferring: Promise<void> | undefined;
  const visible = () => (upload ? dirs.remotePath : dirs.localPath);
  const entries = () => (upload ? dirs.remoteEntries : dirs.localEntries);
  const remembered = () => useStore.getState().tabs[0].directories?.[upload ? "filer" : "local"];
  const navigate = (path = next) => (upload ? dirs.loadRemote(path) : dirs.loadLocal(path));
  const startTransfer = (destination: string) =>
    upload ? transfer.runUpload(file, destination) : transfer.runDownload(file, destination);
  const paneError = () => (upload ? dirs.remoteError : dirs.localError);
  const child = `${initial}/child`;
  const existing = (path: string, isDir = false) => ({
    ...file,
    path: `${path}/${file.name}`,
    isDir,
  });
  const showParentEntry = async (isDir = false) => {
    read.mockResolvedValueOnce(listing(initial, [existing(initial, isDir)]));
    await act(async () => {
      await navigate(initial);
    });
    read.mockClear();
  };
  async function beginTransfer(destination = initial) {
    await act(async () => {
      transferring = startTransfer(destination);
    });
    expect(transfer.transferring).toBe(true);
  }
  const finish = () =>
    act(async () => {
      outgoing.resolve(undefined);
      await transferring;
    });
  function Harness({ state }: { state: Tab["state"] }) {
    dirs = useFtpDirectory({ tab: { ...tab, state }, sessionId });
    transfer = useFtpTransfer({
      ...dirs,
      sessionId,
      selectedLocal: [file],
      selectedRemote: [file],
    });
    return null;
  }
  const render = (state: Tab["state"]) => act(async () => root.render(h(Harness, { state })));

  beforeEach(async () => {
    oldTabs = useStore.getState().tabs;
    useStore.setState({ tabs: [tab] });
    vi.resetAllMocks();
    vi.mocked(api.newTransferId).mockReturnValue("transfer-one");
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(api.sftpHome).mockResolvedValue("/remote");
    vi.mocked(api.localHome).mockResolvedValue("/local");
    vi.mocked(api.sftpList).mockImplementation(async (_, path) => listing(path));
    vi.mocked(api.localList).mockImplementation(async (path) => listing(path));
    outgoing = deferred<void>();
    vi.mocked(api.transferFiles).mockReturnValue(outgoing.promise);
    react.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
    await render("connected");
  });

  afterEach(() => {
    act(() => root.unmount());
    useStore.setState({ tabs: oldTabs });
    react.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("still refreshes the unchanged destination to show the copied file", async () => {
    await beginTransfer();
    read.mockResolvedValueOnce(listing(initial, [file]));
    await finish();
    expect(visits()).toEqual([initial, initial]);
    expect([visible(), entries(), transfer.transfer?.status]).toEqual([
      initial,
      [file],
      "complete",
    ]);
  });

  it("does not send the user back after successful navigation", async () => {
    await beginTransfer();
    await act(async () => {
      await navigate();
    });
    await finish();
    expect(visits()).toEqual([initial, next]);
    expect([visible(), remembered(), transfer.transfer?.status]).toEqual([next, next, "complete"]);
  });

  it.each([true, false])(
    "lets newer pending navigation finish first (success=%s)",
    async (succeeds) => {
      await beginTransfer();
      const pending = deferred<ReturnType<typeof listing>>();
      read.mockReturnValueOnce(pending.promise);
      let navigating: Promise<boolean> | undefined;
      await act(async () => {
        navigating = navigate();
      });
      await act(async () => outgoing.resolve(undefined));
      const beforeNavigationSettles = visits();
      await act(async () => {
        if (succeeds) pending.resolve(listing(next));
        else {
          read.mockResolvedValueOnce(listing(initial, [file]));
          pending.reject(new Error("name unavailable"));
        }
        await navigating;
        await transferring;
      });
      expect(beforeNavigationSettles).toEqual([initial, next]);
      expect(visits()).toEqual(succeeds ? [initial, next] : [initial, next, initial]);
      const expected = succeeds ? next : initial;
      expect([visible(), remembered(), transfer.transfer?.status]).toEqual([
        expected,
        expected,
        "complete",
      ]);
    },
  );

  it.each([true, false])(
    "refreshes the child destination once navigation reaches it (already visible=%s)",
    async (alreadyVisible) => {
      await beginTransfer(child);
      const pending = deferred<ReturnType<typeof listing>>();
      read.mockReturnValueOnce(pending.promise);
      let navigating: Promise<boolean> | undefined;
      await act(async () => {
        navigating = navigate(child);
      });
      const openChild = () =>
        act(async () => {
          pending.resolve(listing(child));
          await navigating;
        });
      read.mockResolvedValueOnce(listing(child, [file]));
      if (alreadyVisible) await openChild();
      else {
        await act(async () => outgoing.resolve(undefined));
        expect(visits()).toEqual([initial, child, child]);
        await openChild();
      }
      await finish();
      expect(visits()).toEqual([initial, child, child, child]);
      expect([visible(), remembered(), entries()]).toEqual([child, child, [file]]);
      const [item] = vi.mocked(api.transferFiles).mock.calls[0][1];
      expect(upload ? item.remote : item.local).toBe(`${child}/${file.name}`);
    },
  );

  it("refreshes the original view without opening the child used as the job destination", async () => {
    await beginTransfer(child);
    await finish();
    expect(visits()).toEqual([initial, child, initial]);
    expect([visible(), remembered()]).toEqual([initial, initial]);
  });

  it("can supersede a stale in-flight read of the same directory", async () => {
    await beginTransfer();
    const stale = deferred<ReturnType<typeof listing>>();
    read.mockReturnValueOnce(stale.promise);
    let reading: Promise<boolean> | undefined;
    await act(async () => {
      reading = navigate(initial);
    });
    read.mockResolvedValueOnce(listing(initial, [file]));
    await finish();
    expect(visits()).toEqual([initial, initial, initial]);
    await act(async () => {
      stale.resolve(listing(initial));
      await reading;
    });
    expect(entries()).toEqual([file]);
  });

  it("does not refresh a newly connected view with the same path after a late transfer", async () => {
    await beginTransfer();
    await render("closed");
    await render("connected");
    expect(visits()).toEqual([initial, initial]);
    await finish();
    expect(visits()).toEqual([initial, initial]);
    expect([visible(), remembered()]).toEqual([initial, initial]);
  });

  it("blocks a child directory with the incoming file's name", async () => {
    read.mockResolvedValueOnce(listing(child, [existing(child, true)]));
    outgoing.resolve(undefined);
    await act(async () => startTransfer(child));
    expect(visits()).toEqual([initial, child]);
    expect(api.transferFiles).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(paneError()).toContain(file.name);
  });

  it.each([false, true])("confirms the child's same-name file (accepted=%s)", async (accepted) => {
    read.mockResolvedValueOnce(listing(child, [existing(child)]));
    vi.mocked(ask).mockResolvedValueOnce(accepted);
    outgoing.resolve(undefined);
    await act(async () => startTransfer(child));
    expect(ask).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(file.name),
      expect.anything(),
    );
    expect(api.transferFiles).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(visits()).toEqual(accepted ? [initial, child, initial] : [initial, child]);
    if (accepted) {
      const [item] = vi.mocked(api.transferFiles).mock.calls[0][1];
      expect(upload ? item.remote : item.local).toBe(`${child}/${file.name}`);
    }
  });

  it("ignores a same-name directory in the parent when the child is empty", async () => {
    await showParentEntry(true);
    outgoing.resolve(undefined);
    await act(async () => startTransfer(child));
    expect(visits()).toEqual([child, initial]);
    expect(ask).not.toHaveBeenCalled();
    expect(api.transferFiles).toHaveBeenCalledOnce();
    expect(paneError()).toBeNull();
  });

  it("does not start a transfer if the child listing failed", async () => {
    read.mockRejectedValueOnce(new Error("Cannot list drop destination"));
    outgoing.resolve(undefined);
    await act(async () => startTransfer(child));
    expect(visits()).toEqual([initial, child]);
    expect(paneError()).toBe("Cannot list drop destination");
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("keeps using the visible entries for toolbar preflight and honors cancellation", async () => {
    await showParentEntry();
    vi.mocked(ask).mockResolvedValueOnce(false);
    await act(async () => {
      if (upload) transfer.upload();
      else transfer.download();
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(visits()).toEqual([]);
    expect(api.transferFiles).not.toHaveBeenCalled();
  });

  it("keeps an awaiting confirmation as the sole attempt", async () => {
    await showParentEntry();
    const confirmation = deferred<boolean>();
    vi.mocked(ask).mockReturnValueOnce(confirmation.promise);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = startTransfer(initial);
      second = startTransfer(initial);
    });
    const prompts = vi.mocked(ask).mock.calls.length;
    const queuedBeforeConfirmation = vi.mocked(api.transferFiles).mock.calls.length;
    await act(async () => {
      confirmation.resolve(true);
      outgoing.resolve(undefined);
      await Promise.all([first, second]);
    });
    expect(prompts).toBe(1);
    expect(queuedBeforeConfirmation).toBe(0);
    expect(api.transferFiles).toHaveBeenCalledOnce();
    expect(transfer.transfer?.status).toBe("complete");
  });

  it("does not enqueue another job while the first child listing is pending", async () => {
    const slow = deferred<ReturnType<typeof listing>>();
    read.mockReturnValueOnce(slow.promise);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = startTransfer(child);
      second = startTransfer(next);
    });
    const pathsBeforeListing = visits();
    const queuedBeforeListing = vi.mocked(api.transferFiles).mock.calls.length;
    await act(async () => {
      slow.resolve(listing(child));
      outgoing.resolve(undefined);
      await Promise.all([first, second]);
    });
    expect(pathsBeforeListing).toEqual([initial, child]);
    expect(queuedBeforeListing).toBe(0);
    expect(api.transferFiles).toHaveBeenCalledOnce();
    const [item] = vi.mocked(api.transferFiles).mock.calls[0][1];
    expect(upload ? item.remote : item.local).toBe(`${child}/${file.name}`);
  });

  it.each([
    "declined",
    "listing failure",
    "setup throw",
    "cancelled",
    "failed",
    "completed",
  ] as const)("allows a new transfer after an attempt is %s", async (outcome) => {
    outgoing.resolve(undefined);
    if (outcome === "declined") {
      read.mockResolvedValueOnce(listing(child, [existing(child)]));
      vi.mocked(ask).mockResolvedValueOnce(false);
    } else if (outcome === "listing failure") {
      read.mockRejectedValueOnce(new Error("Folder unavailable"));
    } else if (outcome === "setup throw") {
      vi.mocked(api.newTransferId).mockImplementationOnce(() => {
        throw new Error("Cannot start transfer");
      });
    } else if (outcome === "cancelled") {
      vi.mocked(api.transferFiles).mockRejectedValueOnce({
        code: "cancelled",
        message: "Cancelled",
      });
    } else if (outcome === "failed") {
      vi.mocked(api.transferFiles).mockRejectedValueOnce(new Error("Could not copy"));
    }
    await act(async () => {
      const attempt = startTransfer(child);
      if (outcome === "setup throw") await expect(attempt).rejects.toThrow("Cannot start transfer");
      else await attempt;
    });
    expect(transfer.transferring).toBe(false);
    expect(transfer.transferId.current).toBeNull();
    const jobs = vi.mocked(api.transferFiles).mock.calls.length;
    await act(async () => startTransfer(child));
    expect(api.transferFiles).toHaveBeenCalledTimes(jobs + 1);
    expect(transfer.transfer?.status).toBe("complete");
  });
});
