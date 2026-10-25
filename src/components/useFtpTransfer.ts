import type { Dispatch, SetStateAction } from "react";
import { errorText, isCancelled } from "../errorInfo";
import { useRef, useState } from "react";
import * as api from "../api";
import { batchCollisions, type BatchBlock } from "../fileBatch";
import { t } from "../i18n";
import { ask } from "../nativeDialog";
import { useFileTransfers } from "../fileTransfers";
import { IS_MAC, IS_WINDOWS } from "../platform";
import { type PaneSide } from "../paneDrop";
import type { FileEntry } from "../types";
import type { TransferState } from "./ftpPresentation";
import { friendlyFtpError, joinLocal, joinRemote } from "./ftpPresentation";

interface Options {
  remotePath: string;
  remoteEntries: FileEntry[];
  sessionId: string;
  localPath: string;
  localEntries: FileEntry[];
  setRemoteError: Dispatch<SetStateAction<string | null>>;
  setLocalError: Dispatch<SetStateAction<string | null>>;
  loadRemote: (target: string) => Promise<void>;
  loadLocal: (target: string) => Promise<void>;
  /** The pane's selection, in listing order; any number of entries. */
  selectedLocal: readonly FileEntry[];
  selectedRemote: readonly FileEntry[];
}

export function useFtpTransfer({
  remotePath,
  remoteEntries,
  sessionId,
  localPath,
  localEntries,
  setRemoteError,
  setLocalError,
  loadRemote,
  loadLocal,
  selectedLocal,
  selectedRemote,
}: Options) {
  const [transferring, setTransferring] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const transferId = useRef<string | null>(null);
  const transferJob = useFileTransfers((s) => s.jobs[transferId.current ?? ""]);

  const updateProgress = (progress: api.TransferProgress) => {
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred: progress.transferred,
            total: progress.total,
          }
        : current,
    );
  };

  /**
   * The entries a landing folder holds, for the conflict checks. The pane in
   * view already has them in hand; a folder row's are fetched.
   */
  const entriesAt = async (side: PaneSide, dir: string): Promise<FileEntry[]> => {
    if (side === "remote") {
      if (dir === remotePath) return remoteEntries;
      return (await api.sftpList(sessionId, dir)).entries;
    }
    if (dir === localPath) return localEntries;
    return (await api.localList(dir)).entries;
  };

  const sideLabel = (side: PaneSide) =>
    side === "remote" ? t("ftp.sideRemote") : t("ftp.sideLocal");

  /** Why a batch cannot land at all, in the destination pane's wording. */
  const blockedMessage = (side: PaneSide, block: BatchBlock): string =>
    block.kind === "symlink"
      ? t("ftp.refuseSymlink", { name: block.existing.name })
      : t(block.existing.isDir ? "ftp.folderExists" : "ftp.fileExists", {
          side: sideLabel(side),
          name: block.existing.name,
        });

  /**
   * The gate every landing shares: same-name checks against the destination
   * pane's listing before anything is sent, then one confirmation for the
   * whole batch. False means stop — an error was shown or the user declined.
   * A single entry keeps the wording it has always had; several are counted.
   */
  const mayLand = async (
    direction: "upload" | "download",
    items: readonly FileEntry[],
  ): Promise<boolean> => {
    const upload = direction === "upload";
    const side: PaneSide = upload ? "remote" : "local";
    const destination = upload ? remotePath : localPath;
    const setError = upload ? setRemoteError : setLocalError;
    let present: FileEntry[];
    try {
      present = await entriesAt(side, destination);
    } catch (error) {
      setError(upload ? friendlyFtpError(error) : errorText(error));
      return false;
    }
    const collisions = batchCollisions(
      items,
      present,
      side,
      // APFS and NTFS match local names case-insensitively by default.
      side === "local" && (IS_MAC || IS_WINDOWS),
    );
    if (collisions.blocked) {
      setError(blockedMessage(side, collisions.blocked));
      return false;
    }
    const single = items.length === 1 ? collisions.existing[0] : undefined;
    if (!collisions.existing.length) return true;
    if (single) {
      return ask(
        t(single.isDir ? "ftp.mergeFolder" : "ftp.replaceFile", {
          side: sideLabel(side),
          name: single.name,
        }),
        {
          title: t("filer.replaceTitle"),
          kind: "warning",
          okLabel: t("filer.downloadReplace"),
          cancelLabel: t("common.cancel"),
        },
      );
    }
    return ask(t("filer.replaceConfirm", { count: collisions.existing.length }), {
      title: t("filer.replaceTitle"),
      kind: "warning",
      okLabel: t("filer.replace"),
      cancelLabel: t("common.cancel"),
    });
  };

  /**
   * Copies `items` into `destination`, all of them in one queue job (upstream
   * issue #101). The batch is checked against the destination's listing first:
   * a clash with a link or with the other kind stops it before anything is
   * sent, and names already there are confirmed once for the whole batch.
   */
  const runTransfer = async (
    direction: "upload" | "download",
    items: readonly FileEntry[],
    destination: string,
  ) => {
    if (transferring || !destination || items.length === 0) return;
    const upload = direction === "upload";
    const setError = upload ? setRemoteError : setLocalError;
    if (!(await mayLand(direction, items))) return;

    setError(null);
    setTransferring(true);
    transferId.current = api.newTransferId();
    setTransfer({
      direction,
      name: items.length === 1 ? items[0].name : t("filer.manyItems", { count: items.length }),
      transferred: 0,
      total: items.reduce((sum, item) => sum + (item.isDir ? 0 : item.size), 0),
      status: "running",
    });
    const transferItems: api.TransferItem[] = items.map((item) => ({
      local: upload ? item.path : joinLocal(destination, item.name),
      remote: upload ? joinRemote(destination, item.name) : item.path,
      upload,
      directory: item.isDir,
    }));
    try {
      await api.transferFiles(sessionId, transferItems, updateProgress, transferId.current);
      setTransfer((current) => (current ? { ...current, status: "complete" } : current));
      await (upload ? loadRemote(remotePath) : loadLocal(localPath));
    } catch (error) {
      setTransfer((current) =>
        current
          ? {
              ...current,
              status: isCancelled(error) ? "cancelled" : "error",
              message: errorText(error),
            }
          : current,
      );
    } finally {
      transferId.current = null;
      setTransferring(false);
    }
  };

  /** The drag/drop path: one entry into the folder it was dropped on. */
  const runUpload = (incoming: FileEntry, destDir: string) =>
    runTransfer("upload", [incoming], destDir);
  const runDownload = (incoming: FileEntry, destDir: string) =>
    runTransfer("download", [incoming], destDir);

  /** The toolbar, rail and context menu: whatever the pane has selected. */
  const upload = () => void runTransfer("upload", selectedLocal, remotePath);
  const download = () => void runTransfer("download", selectedRemote, localPath);
  const uploadEntries = (items: readonly FileEntry[]) =>
    void runTransfer("upload", items, remotePath);
  const downloadEntries = (items: readonly FileEntry[]) =>
    void runTransfer("download", items, localPath);

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(100, (transfer.transferred / transfer.total) * 100)
        : null
    : null;

  return {
    transferring,
    runUpload,
    runDownload,
    upload,
    download,
    uploadEntries,
    downloadEntries,
    transfer,
    transferPercent,
    transferId,
    transferJob,
  };
}
