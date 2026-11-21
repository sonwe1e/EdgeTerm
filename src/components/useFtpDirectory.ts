import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../errorInfo";
import * as api from "../api";
import { EMPTY_SELECTION, selectedEntries, type FileSelection } from "../fileBatch";
import { useStore, type Tab } from "../store";
import { rememberWorkspaceDirectory } from "../workspaceDirectories";
import type { FileEntry } from "../types";
import { friendlyFtpError } from "./ftpPresentation";

interface Options {
  sessionId: string;
  tab: Tab;
}

interface DirectoryView {
  path: string;
  epoch: number;
  pending?: { target: string; done: Promise<void>; finish: () => void };
}

function startDirectoryRead(view: DirectoryView, target: string) {
  view.pending?.finish();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return (view.pending = { target, done, finish });
}

function commitDirectoryPath(view: DirectoryView, path: string) {
  if (view.path === path) return;
  view.path = path;
  view.epoch++;
}

function retireDirectoryView(view: DirectoryView) {
  view.epoch++;
  view.pending?.finish();
  view.pending = undefined;
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
  const localView = useRef<DirectoryView>({ path: "", epoch: 0 });
  const remoteView = useRef<DirectoryView>({ path: "", epoch: 0 });

  const loadRemote = useCallback(
    async (target: string, quiet = false, deleteError: string | null = null): Promise<boolean> => {
      const view = remoteView.current;
      const request = startDirectoryRead(view, target);
      setRemoteLoading(true);
      setRemoteError(deleteError);
      try {
        const listing = await api.sftpList(sessionId, target);
        if (request !== view.pending) return false;
        commitDirectoryPath(view, listing.path);
        setRemotePath(listing.path);
        setRemoteDraft(listing.path);
        setRemoteEntries(listing.entries);
        setRemoteSelection(EMPTY_SELECTION);
        rememberWorkspaceDirectory(sessionId, "filer", listing.path);
        return true;
      } catch (error) {
        if (request === view.pending && !quiet && deleteError === null)
          setRemoteError(friendlyFtpError(error));
        return false;
      } finally {
        if (request === view.pending) {
          view.pending = undefined;
          setRemoteLoading(false);
        }
        request.finish();
      }
    },
    [sessionId],
  );

  const loadLocal = useCallback(
    async (target: string, quiet = false, deleteError: string | null = null): Promise<boolean> => {
      const view = localView.current;
      const request = startDirectoryRead(view, target);
      setLocalLoading(true);
      setLocalError(deleteError);
      try {
        const listing = await api.localList(target);
        if (request !== view.pending) return false;
        commitDirectoryPath(view, listing.path);
        setLocalPath(listing.path);
        setLocalDraft(listing.path);
        setLocalEntries(listing.entries);
        setLocalSelection(EMPTY_SELECTION);
        rememberWorkspaceDirectory(sessionId, "local", listing.path);
        return true;
      } catch (error) {
        if (request === view.pending && !quiet && deleteError === null)
          setLocalError(errorText(error));
        return false;
      } finally {
        if (request === view.pending) {
          view.pending = undefined;
          setLocalLoading(false);
        }
        request.finish();
      }
    },
    [sessionId],
  );

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
        const saved = useStore
          .getState()
          .tabs.find((item) => item.info.id === sessionId)?.directories;
        await Promise.all([
          (async () => {
            if (saved?.filer !== undefined && (await loadRemote(saved.filer, true))) return;
            if (!cancelled) await loadRemote(ftpHome);
          })(),
          (async () => {
            if (saved?.local !== undefined && (await loadLocal(saved.local, true))) return;
            if (!cancelled) await loadLocal(machineHome);
          })(),
        ]);
      } catch (error) {
        if (!cancelled) setRemoteError(friendlyFtpError(error));
      }
    })();

    return () => {
      cancelled = true;
      retireDirectoryView(remoteView.current);
      retireDirectoryView(localView.current);
    };
  }, [loadLocal, loadRemote, sessionId, tab.state]);

  const beginDeleteRefresh = (side: "remote" | "local", target: string) => {
    const view = side === "remote" ? remoteView.current : localView.current;
    const load = side === "remote" ? loadRemote : loadLocal;
    const epoch = view.epoch;
    return async (deleteError: string | null) => {
      while (view.epoch === epoch && view.path === target) {
        const pending = view.pending;
        // A same-directory read may contain pre-delete rows. A navigation
        // elsewhere gets to finish first; failure leaves this view in place.
        if (!pending || pending.target === target) {
          await load(target, false, deleteError);
          return;
        }
        await pending.done;
      }
    };
  };

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
    beginDeleteRefresh,
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
