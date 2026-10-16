import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
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
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const [localHome, setLocalHome] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [localDraft, setLocalDraft] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
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
        setRemoteSelected(null);
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
      setLocalSelected(null);
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

  const selectedRemote = useMemo(
    () => remoteEntries.find((entry) => entry.path === remoteSelected),
    [remoteEntries, remoteSelected],
  );
  const selectedLocal = useMemo(
    () => localEntries.find((entry) => entry.path === localSelected),
    [localEntries, localSelected],
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
    remoteSelected,
    remoteLoading,
    remoteError,
    setRemoteDraft,
    remoteHome,
    setRemoteSelected,
    localLoading,
    localDraft,
    localSelected,
    localError,
    setLocalDraft,
    localHome,
    setLocalSelected,
  };
}
