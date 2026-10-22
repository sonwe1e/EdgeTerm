import type { Dispatch, SetStateAction } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { t } from "../i18n";
import { ask } from "../nativeDialog";
import type { FileEntry } from "../types";
import { friendlyFtpError, joinLocal, joinRemote } from "./ftpPresentation";

interface Options {
  remotePath: string;
  transferring: boolean;
  setRemoteError: Dispatch<SetStateAction<string | null>>;
  sessionId: string;
  loadRemote: (target: string) => Promise<void>;
  selectedRemote: FileEntry | undefined;
  localPath: string;
  setLocalError: Dispatch<SetStateAction<string | null>>;
  loadLocal: (target: string) => Promise<void>;
  selectedLocal: FileEntry | undefined;
}

/**
 * Mutations behind the dual-pane toolbars. Create and rename take the name
 * from the dialog the caller shows, so a rejected name stays in its field and
 * a failure surfaces there instead of only in the panel's error line. Delete
 * asks first and reports into the panel.
 */
export function useFtpActions({
  remotePath,
  transferring,
  setRemoteError,
  sessionId,
  loadRemote,
  selectedRemote,
  localPath,
  setLocalError,
  loadLocal,
  selectedLocal,
}: Options) {
  const createRemoteFolder = async (name: string) => {
    if (!remotePath || transferring) return;
    setRemoteError(null);
    try {
      await api.sftpMkdir(sessionId, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      throw new Error(friendlyFtpError(error));
    }
  };

  const renameRemote = async (name: string) => {
    if (!selectedRemote || transferring || name === selectedRemote.name) return;
    setRemoteError(null);
    try {
      await api.sftpRename(
        sessionId,
        selectedRemote.path,
        joinRemote(remotePath, name),
      );
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

  const removeRemote = async () => {
    if (!selectedRemote || transferring) return;
    const { folder, recursive } = deleteMode(selectedRemote);
    const confirmed = await ask(
      folder
        ? t("ftp.deleteRemoteFolderConfirm", { name: selectedRemote.name })
        : t("ftp.deleteRemoteConfirm", { name: selectedRemote.name }),
      {
        title: t("ftp.deleteTitle"),
        kind: "warning",
        okLabel: folder ? t("ftp.deleteFolderAction") : t("common.delete"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!confirmed) return;
    setRemoteError(null);
    try {
      await api.sftpRemove(sessionId, selectedRemote.path, selectedRemote.isDir, recursive);
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const createLocalFolder = async (name: string) => {
    if (!localPath || transferring) return;
    setLocalError(null);
    try {
      await api.localMkdir(joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  const renameLocal = async (name: string) => {
    if (!selectedLocal || transferring || name === selectedLocal.name) return;
    setLocalError(null);
    try {
      await api.localRename(selectedLocal.path, joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  const removeLocal = async () => {
    if (!selectedLocal || transferring) return;
    const { folder, recursive } = deleteMode(selectedLocal);
    const confirmed = await ask(
      folder
        ? t("ftp.deleteLocalFolderConfirm", { name: selectedLocal.name })
        : t("ftp.deleteLocalConfirm", { name: selectedLocal.name }),
      {
        title: t("ftp.deleteTitle"),
        kind: "warning",
        okLabel: folder ? t("ftp.deleteFolderAction") : t("common.delete"),
        cancelLabel: t("common.cancel"),
      },
    );
    if (!confirmed) return;
    setLocalError(null);
    try {
      await api.localRemove(selectedLocal.path, selectedLocal.isDir, recursive);
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(errorText(error));
    }
  };

  return {
    createRemoteFolder,
    renameRemote,
    removeRemote,
    createLocalFolder,
    renameLocal,
    removeLocal,
  };
}
