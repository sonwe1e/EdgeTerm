import { beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, Channel: class {} }));
import { sftpDownload, sftpUploadDirectory, transferFiles } from "./api";
import { saveTransferOptions } from "./transferSettings";
beforeEach(() => { ipc.invoke.mockClear(); localStorage.clear(); });

it("routes both panes and batches through the same job API with selected limits", async () => {
  saveTransferOptions({ requests: 8, chunkKib: 32, files: 2, durable: false, tar: false });
  await sftpDownload("ssh", "/remote", "C:\\local", () => {}, "download-task");
  expect(ipc.invoke).toHaveBeenLastCalledWith("transfer_files", expect.objectContaining({
    transfer: "download-task", items: [{ remote: "/remote", local: "C:\\local", upload: false, directory: false }],
    options: { requests: 8, chunkKib: 32, files: 2, durable: false, tar: false },
  }));
  await sftpUploadDirectory("ftp", "C:\\tree", "/tree", () => {}, "folder-task");
  expect(ipc.invoke.mock.lastCall![1].items[0].directory).toBe(true);
  const items = [{ local: "a", remote: "/a", upload: true }, { local: "b", remote: "/b", upload: true }];
  await transferFiles("ssh", items, () => {}, "batch-task");
  expect(ipc.invoke.mock.lastCall![1].items).toEqual(items);
  expect(ipc.invoke).toHaveBeenCalledTimes(3);
});
