import type { Dispatch, SetStateAction } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { t } from "../i18n";
import { ask } from "../nativeDialog";
import type { FileEntry } from "../types";
import type { BeginDirectoryRefresh } from "./useFtpDirectory";
import { friendlyFtpError, joinLocal, joinRemote } from "./ftpPresentation";

interface Options {
  beginDirectoryRefresh: BeginDirectoryRefresh;
  remotePath: string;
  transferring: boolean;
  setRemoteError: Dispatch<SetStateAction<string | null>>;
  /** The pane's operation notice; see `remoteNotice` in useFtpDirectory. */
  setRemoteNotice: Dispatch<SetStateAction<string | null>>;
  sessionId: string;
  loadRemote: (target: string) => Promise<unknown>;
  /** The pane's selection, in listing order. Rename needs exactly one. */
  selectedRemote: readonly FileEntry[];
  localPath: string;
  setLocalError: Dispatch<SetStateAction<string | null>>;
  setLocalNotice: Dispatch<SetStateAction<string | null>>;
  loadLocal: (target: string) => Promise<unknown>;
  selectedLocal: readonly FileEntry[];
}

/**
 * Mutations behind the dual-pane toolbars, rail and row menus. Create and
 * rename take the name from the dialog the caller shows, so a rejected name
 * stays in its field and a failure surfaces there instead of only in the
 * panel's error line. Delete asks first and reports beside the rows; a batch
 * of entries is asked about once by the caller, then removed here one after
 * another. A delete's failure is reported as a notice beside the refreshed
 * rows (see useFtpDirectory), so starting any of these operations clears the
 * one before it rather than leaving a finished failure on screen.
 */
export function useFtpActions({
  beginDirectoryRefresh,
  remotePath,
  transferring,
  setRemoteError,
  setRemoteNotice,
  sessionId,
  loadRemote,
  selectedRemote,
  localPath,
  setLocalError,
  setLocalNotice,
  loadLocal,
  selectedLocal,
}: Options) {
  const createRemoteFolder = async (name: string) => {
    if (!remotePath || transferring) return;
    setRemoteError(null);
    setRemoteNotice(null);
    try {
      await api.sftpMkdir(sessionId, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      throw new Error(friendlyFtpError(error));
    }
  };

  /**
   * Renames the one selected entry, or an explicit row a menu named before
   * its selection landed.
   */
  const renameRemote = async (name: string, entry?: FileEntry) => {
    const target = entry ?? (selectedRemote.length === 1 ? selectedRemote[0] : undefined);
    if (!target || transferring || name === target.name) return;
    setRemoteError(null);
    setRemoteNotice(null);
    try {
      await api.sftpRename(sessionId, target.path, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      throw new Error(friendlyFtpError(error));
    }
  };

  /**
   * The deletion a pane entry needs: a folder goes with its contents (and the
   * dialog says so), a link only ever removes itself, so it is not walked.
   */
  const deleteMode = (entry: FileEntry) => {
    const folder = entry.isDir && !entry.isSymlink;
    return { folder, recursive: folder };
  };

  /**
   * Removes `entries`, asking the same question a single delete has always
   * asked. The batch confirmation, when the caller has several selected, is
   * the caller's delete dialog; this only does the work.
   */
  const removeRemoteEntries = async (entries: readonly FileEntry[]) => {
    const [target] = entries;
    if (!target || transferring) return;
    const refresh = beginDirectoryRefresh("remote", remotePath);
    if (entries.length === 1) {
      const { folder } = deleteMode(target);
      const confirmed = await ask(
        folder
          ? t("ftp.deleteRemoteFolderConfirm", { name: target.name })
          : t("ftp.deleteRemoteConfirm", { name: target.name }),
        {
          title: t("ftp.deleteTitle"),
          kind: "warning",
          okLabel: folder ? t("ftp.deleteFolderAction") : t("common.delete"),
          cancelLabel: t("common.cancel"),
        },
      );
      if (!confirmed) return;
    }
    // A confirmed attempt replaces whatever the last operation reported; a
    // declined one keeps it, since nothing new was tried.
    setRemoteNotice(null);
    let failure: string | null = null;
    try {
      for (const entry of entries) {
        const { recursive } = deleteMode(entry);
        await api.sftpRemove(sessionId, entry.path, entry.isDir, recursive);
      }
    } catch (error) {
      failure = friendlyFtpError(error);
    }
    await refresh(failure);
  };

  const createLocalFolder = async (name: string) => {
    if (!localPath || transferring) return;
    setLocalError(null);
    setLocalNotice(null);
    try {
      await api.localMkdir(joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  const renameLocal = async (name: string, entry?: FileEntry) => {
    const target = entry ?? (selectedLocal.length === 1 ? selectedLocal[0] : undefined);
    if (!target || transferring || name === target.name) return;
    setLocalError(null);
    setLocalNotice(null);
    try {
      await api.localRename(target.path, joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  const removeLocalEntries = async (entries: readonly FileEntry[]) => {
    const [target] = entries;
    if (!target || transferring) return;
    const refresh = beginDirectoryRefresh("local", localPath);
    if (entries.length === 1) {
      const { folder } = deleteMode(target);
      const confirmed = await ask(
        folder
          ? t("ftp.deleteLocalFolderConfirm", { name: target.name })
          : t("ftp.deleteLocalConfirm", { name: target.name }),
        {
          title: t("ftp.deleteTitle"),
          kind: "warning",
          okLabel: folder ? t("ftp.deleteFolderAction") : t("common.delete"),
          cancelLabel: t("common.cancel"),
        },
      );
      if (!confirmed) return;
    }
    // See `removeRemoteEntries` for why this clears only a confirmed attempt.
    setLocalNotice(null);
    let failure: string | null = null;
    try {
      for (const entry of entries) {
        const { recursive } = deleteMode(entry);
        await api.localRemove(entry.path, entry.isDir, recursive);
      }
    } catch (error) {
      failure = errorText(error);
    }
    await refresh(failure);
  };

  return {
    createRemoteFolder,
    renameRemote,
    removeRemoteEntries,
    createLocalFolder,
    renameLocal,
    removeLocalEntries,
  };
}
