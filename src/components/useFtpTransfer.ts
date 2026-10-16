import type { Dispatch, SetStateAction } from "react";
import { useRef, useState } from "react";
import * as api from "../api";
import { useFileTransfers } from "../fileTransfers";
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
  selectedLocal: FileEntry | undefined;
  selectedRemote: FileEntry | undefined;
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

  /**
   * The gate every landing shares: same-name checks with the target pane's
   * wording. False means stop — an error was shown or the user declined.
   */
  const mayLand = (
    side: PaneSide,
    incoming: FileEntry,
    existing: FileEntry | undefined,
  ): boolean => {
    const setError = side === "remote" ? setRemoteError : setLocalError;
    if (!existing) return true;
    if (side === "local" && existing.isSymlink) {
      setError(`Refusing to replace local symlink “${incoming.name}”.`);
      return false;
    }
    if (existing.isDir !== incoming.isDir) {
      setError(
        incoming.isDir
          ? `A ${side} file named “${incoming.name}” already exists.`
          : `A ${side} folder named “${incoming.name}” already exists.`,
      );
      return false;
    }
    const prompt = incoming.isDir
      ? `Merge into ${side} folder “${incoming.name}”? Existing files with the same names will be replaced.`
      : `Replace ${side} file “${incoming.name}”?`;
    return window.confirm(prompt);
  };

  const runUpload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("remote", destDir)).find((entry) => entry.name === incoming.name);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
      return;
    }
    if (!mayLand("remote", incoming, existing)) return;

    setRemoteError(null);
    setTransferring(true);
    transferId.current = api.newTransferId();
    setTransfer({
      direction: "upload",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinRemote(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpUploadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      } else {
        await api.sftpUpload(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      }
      setTransfer((current) => (current ? { ...current, status: "complete" } : current));
      await loadRemote(remotePath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? {
              ...current,
              status: String(error).includes("transfer cancelled") ? "cancelled" : "error",
              message: String(error),
            }
          : current,
      );
    } finally {
      transferId.current = null;
      setTransferring(false);
    }
  };

  const runDownload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("local", destDir)).find((entry) => entry.name === incoming.name);
    } catch (error) {
      setLocalError(String(error));
      return;
    }
    if (!mayLand("local", incoming, existing)) return;

    setLocalError(null);
    setTransferring(true);
    transferId.current = api.newTransferId();
    setTransfer({
      direction: "download",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinLocal(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      }
      setTransfer((current) => (current ? { ...current, status: "complete" } : current));
      await loadLocal(localPath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? {
              ...current,
              status: String(error).includes("transfer cancelled") ? "cancelled" : "error",
              message: String(error),
            }
          : current,
      );
    } finally {
      transferId.current = null;
      setTransferring(false);
    }
  };

  const upload = () => {
    if (selectedLocal) void runUpload(selectedLocal, remotePath);
  };

  const download = () => {
    if (selectedRemote) void runDownload(selectedRemote, localPath);
  };

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
    transfer,
    transferPercent,
    transferId,
    transferJob,
  };
}
