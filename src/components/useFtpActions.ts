import type { Dispatch, SetStateAction } from "react";
import * as api from "../api";
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
  const createRemoteFolder = async () => {
    if (!remotePath || transferring) return;
    const name = window.prompt("New remote folder name")?.trim();
    if (!name) return;
    setRemoteError(null);
    try {
      await api.sftpMkdir(sessionId, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const renameRemote = async () => {
    if (!selectedRemote || transferring) return;
    const name = window.prompt("Rename remote item", selectedRemote.name)?.trim();
    if (!name || name === selectedRemote.name) return;
    setRemoteError(null);
    try {
      await api.sftpRename(sessionId, selectedRemote.path, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const removeRemote = async () => {
    if (!selectedRemote || transferring) return;
    if (!window.confirm(`Delete remote ${selectedRemote.name}?`)) return;
    setRemoteError(null);
    try {
      await api.sftpRemove(sessionId, selectedRemote.path, selectedRemote.isDir);
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const createLocalFolder = async () => {
    if (!localPath || transferring) return;
    const name = window.prompt("New local folder name")?.trim();
    if (!name) return;
    setLocalError(null);
    try {
      await api.localMkdir(joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const renameLocal = async () => {
    if (!selectedLocal || transferring) return;
    const name = window.prompt("Rename local item", selectedLocal.name)?.trim();
    if (!name || name === selectedLocal.name) return;
    setLocalError(null);
    try {
      await api.localRename(selectedLocal.path, joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const removeLocal = async () => {
    if (!selectedLocal || transferring) return;
    const type = selectedLocal.isDir ? "empty local folder" : "local file";
    if (!window.confirm(`Delete ${type} “${selectedLocal.name}”?`)) return;
    setLocalError(null);
    try {
      await api.localRemove(selectedLocal.path, selectedLocal.isDir);
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
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
