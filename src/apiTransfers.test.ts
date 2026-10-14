import { beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, Channel: class { onmessage?: (m: unknown) => void } }));
import { cancelFileDiff, compareFiles, recoverTransfer, sftpDownload, sftpUploadDirectory, transferFiles } from "./api";
import { saveTransferOptions } from "./transferSettings";
beforeEach(() => { ipc.invoke.mockClear(); localStorage.clear(); });

it("sends comparison paths and request identity through the IPC contract", async () => {
  await compareFiles("ssh", "request-1", "C:\\local", "/remote");
  expect(ipc.invoke).toHaveBeenLastCalledWith("compare_files", {id:"ssh",requestId:"request-1",local:"C:\\local",remote:"/remote"});
  await cancelFileDiff("request-1");
  expect(ipc.invoke).toHaveBeenLastCalledWith("cancel_file_diff", {requestId:"request-1"});
});

it("routes both panes and batches through the same job API with selected limits", async () => {
  saveTransferOptions({ requests: 8, chunkKib: 32, files: 2, durable: false, tar: false, rateLimitBps: 256 * 1024 });
  await sftpDownload("ssh", "/remote", "C:\\local", () => {}, "download-task");
  expect(ipc.invoke).toHaveBeenLastCalledWith("transfer_files", expect.objectContaining({
    transfer: "download-task", items: [{ remote: "/remote", local: "C:\\local", upload: false, directory: false }],
    options: { requests: 8, chunkKib: 32, files: 2, durable: false, tar: false, rateLimitBps: 256 * 1024 },
  }));
  await sftpUploadDirectory("ftp", "C:\\tree", "/tree", () => {}, "folder-task");
  expect(ipc.invoke.mock.lastCall![1].items[0].directory).toBe(true);
  const items = [{ local: "a", remote: "/a", upload: true }, { local: "b", remote: "/b", upload: true }];
  await transferFiles("ssh", items, () => {}, "batch-task");
  expect(ipc.invoke.mock.lastCall![1].items).toEqual(items);
  expect(ipc.invoke).toHaveBeenCalledTimes(3);
});

it("recovers an interrupted transfer with the progress channel the backend requires", async () => {
  // The backend command declares on_progress as a required Channel; an
  // invoke without one is rejected by the real bridge, so the shape is
  // asserted here rather than left to a permissive mock.
  const onProgress = vi.fn();
  ipc.invoke.mockResolvedValueOnce(undefined);
  const pending = recoverTransfer("journal-1", onProgress);
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  const [command, args] = ipc.invoke.mock.lastCall!;
  expect(command).toBe("recover_transfer");
  expect(args.transfer).toBe("journal-1");
  expect(args.onProgress).toBeInstanceOf(Object);
  expect(typeof args.onProgress.onmessage).toBe("function");
  args.onProgress.onmessage({ transferred: 10, total: 100 });
  expect(onProgress).toHaveBeenCalledWith({ transferred: 10, total: 100 });
  await expect(pending).resolves.toBeUndefined();
});
