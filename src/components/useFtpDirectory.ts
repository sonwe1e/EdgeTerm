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

export type BeginDirectoryRefresh = (
  side: "remote" | "local",
  originalPath: string,
  destination?: string,
) => (operationError: string | null) => Promise<void>;

interface DirectoryView {
  path: string;
  epoch: number;
  lifetime: number;
  readGeneration: number;
  pending?: { target: string | null; done: Promise<void>; finish: () => void };
}

function startDirectoryRead(view: DirectoryView, target: string | null) {
  view.readGeneration++;
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
  view.lifetime++;
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
  const localView = useRef<DirectoryView>({ path: "", epoch: 0, lifetime: 0, readGeneration: 0 });
  const remoteView = useRef<DirectoryView>({ path: "", epoch: 0, lifetime: 0, readGeneration: 0 });

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
    async (
      target: string | (() => Promise<string>),
      quiet = false,
      deleteError: string | null = null,
    ): Promise<boolean> => {
      const view = localView.current;
      const request = startDirectoryRead(view, typeof target === "string" ? target : null);
      setLocalLoading(true);
      setLocalError(deleteError);
      try {
        const path = typeof target === "string" ? target : await target();
        if (request !== view.pending) return false;
        request.target = path;
        const listing = await api.localList(path);
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
    const initialRemote = remoteView.current.readGeneration;
    const initialLocal = localView.current.readGeneration;

    async function restore(
      view: DirectoryView,
      initial: number,
      load: (path: string, quiet?: boolean) => Promise<boolean>,
      saved: string | undefined,
      home: string,
    ) {
      if (cancelled || view.readGeneration !== initial) return;
      if (saved !== undefined) {
        const result = load(saved, true);
        const request = view.readGeneration;
        // A superseded read also returns false, but must not trigger Home.
        if ((await result) || cancelled || view.readGeneration !== request) return;
      }
      await load(home);
    }

    void (async () => {
      // The two lookups belong to different panes, so they settle separately:
      // a Home failure must be reported on the pane that asked for it and must
      // not stop the other pane from restoring. Awaiting both in one try/catch
      // gave the catch no pane to report on, so it always used the remote one;
      // a local failure left the local pane empty with its message on the
      // remote pane.
      const [ftpHome, machineHome] = await Promise.allSettled([
        api.sftpHome(sessionId),
        api.localHome(),
      ]);
      if (cancelled) return;
      if (ftpHome.status === "fulfilled") setRemoteHome(ftpHome.value);
      else if (remoteView.current.readGeneration === initialRemote)
        setRemoteError(friendlyFtpError(ftpHome.reason));
      if (machineHome.status === "fulfilled") setLocalHome(machineHome.value);
      else if (localView.current.readGeneration === initialLocal)
        setLocalError(errorText(machineHome.reason));
      const saved = useStore
        .getState()
        .tabs.find((item) => item.info.id === sessionId)?.directories;
      // A pane whose Home lookup failed has no fallback left, and starting a
      // listing would clear the failure it just reported; it keeps the
      // message. The healthy pane restores regardless.
      await Promise.all([
        ftpHome.status === "fulfilled"
          ? restore(remoteView.current, initialRemote, loadRemote, saved?.filer, ftpHome.value)
          : undefined,
        machineHome.status === "fulfilled"
          ? restore(localView.current, initialLocal, loadLocal, saved?.local, machineHome.value)
          : undefined,
      ]);
    })()
      // The lookups settle above, so a rejection here is unexpected: report it
      // on both panes instead of letting it become an unhandled rejection and
      // leaving two blank panes with nothing said.
      .catch((error: unknown) => {
        if (cancelled) return;
        setRemoteError(friendlyFtpError(error));
        setLocalError(errorText(error));
      });

    return () => {
      cancelled = true;
      retireDirectoryView(remoteView.current);
      retireDirectoryView(localView.current);
    };
  }, [loadLocal, loadRemote, sessionId, tab.state]);

  const beginDirectoryRefresh: BeginDirectoryRefresh = (side, originalPath, destination) => {
    const view = side === "remote" ? remoteView.current : localView.current;
    const load = side === "remote" ? loadRemote : loadLocal;
    const { epoch, lifetime } = view;
    return async (operationError) => {
      while (view.lifetime === lifetime) {
        const { path, pending } = view;
        const isOriginal = view.epoch === epoch && path === originalPath;
        const canRefresh = isOriginal || path === destination;
        if (!canRefresh && destination === undefined) return;

        // Reconcile after navigation, not instead of it. A same-directory
        // read may contain rows captured before the operation completed.
        if (pending && pending.target !== path) {
          await pending.done;
          continue;
        }
        if (canRefresh) await load(path, false, operationError);
        return;
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
    beginDirectoryRefresh,
    remotePath,
    remoteEntries,
    localPath,
    localEntries,
    setRemoteError,
    setLocalError,
    loadRemote,
    loadLocal,
    loadLocalParent: () => loadLocal(() => api.localParent(localPath)),
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
