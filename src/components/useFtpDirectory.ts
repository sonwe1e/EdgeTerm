import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { EMPTY_SELECTION, selectedEntries, type FileSelection } from "../fileBatch";
import type { Tab } from "../store";
import type { FileEntry } from "../types";
import { friendlyFtpError } from "./ftpPresentation";

interface Options {
  sessionId: string;
  tab: Tab;
}

export function useFtpDirectory({ sessionId, tab }: Options) {
  const [remoteHome, setRemoteHome] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [remoteDraft, setRemoteDraft] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const [localHome, setLocalHome] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [localDraft, setLocalDraft] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelection, setLocalSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const localRequest = useRef(0);
  const remoteRequest = useRef(0);

  const loadRemote = useCallback(
    async (target: string) => {
      const request = ++remoteRequest.current;
      setRemoteLoading(true);
      setRemoteError(null);
      try {
        const listing = await api.sftpList(sessionId, target);
        if (request !== remoteRequest.current) return;
        setRemotePath(listing.path);
        setRemoteDraft(listing.path);
        setRemoteEntries(listing.entries);
        setRemoteSelection(EMPTY_SELECTION);
      } catch (error) {
        if (request !== remoteRequest.current) return;
        setRemoteError(friendlyFtpError(error));
      } finally {
        if (request === remoteRequest.current) setRemoteLoading(false);
      }
    },
    [sessionId],
  );

  const loadLocal = useCallback(async (target: string) => {
    const request = ++localRequest.current;
    setLocalLoading(true);
    setLocalError(null);
    try {
      const listing = await api.localList(target);
      if (request !== localRequest.current) return;
      setLocalPath(listing.path);
      setLocalDraft(listing.path);
      setLocalEntries(listing.entries);
      setLocalSelection(EMPTY_SELECTION);
    } catch (error) {
      if (request !== localRequest.current) return;
      setLocalError(errorText(error));
    } finally {
      if (request === localRequest.current) setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab.state !== "connected") return;
    let cancelled = false;

    void (async () => {
      try {
        const [ftpHome, machineHome] = await Promise.all([
          api.sftpHome(sessionId),
          api.localHome(),
        ]);
        if (cancelled) return;
        setRemoteHome(ftpHome);
        setLocalHome(machineHome);
        await Promise.all([loadRemote(ftpHome), loadLocal(machineHome)]);
      } catch (error) {
        if (!cancelled) setRemoteError(friendlyFtpError(error));
      }
    })();

    return () => {
      cancelled = true;
      remoteRequest.current++;
      localRequest.current++;
    };
  }, [loadLocal, loadRemote, sessionId, tab.state]);

  // The selected entries in listing order, which is the order the transfer
  // batch runs in and the order a rename or context menu sees.
  const selectedRemote = useMemo(
    () => selectedEntries(remoteEntries, remoteSelection),
    [remoteEntries, remoteSelection],
  );
  const selectedLocal = useMemo(
    () => selectedEntries(localEntries, localSelection),
    [localEntries, localSelection],
  );

  return {
    remotePath,
    remoteEntries,
    localPath,
    localEntries,
    setRemoteError,
    setLocalError,
    loadRemote,
    loadLocal,
    selectedLocal,
    selectedRemote,
    remoteDraft,
    remoteSelection,
    remoteLoading,
    remoteError,
    setRemoteDraft,
    remoteHome,
    setRemoteSelection,
    localLoading,
    localDraft,
    localSelection,
    localError,
    setLocalDraft,
    localHome,
    setLocalSelection,
  };
}
