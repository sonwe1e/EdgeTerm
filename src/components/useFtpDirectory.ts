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

/**
 * Reloads a pane once an operation has finished, reporting its failure.
 *
 * `destination` is the directory a transfer wrote into. Only an in-place
 * operation (a deletion) leaves it out. A destination-bearing call whose pane
 * has since moved to a third directory reconciles nothing, so its failure is
 * not reported here: a transfer's failure belongs to its own footer, which the
 * caller already holds. Anything new that passes a destination and expects its
 * failure on the pane has to add that path first.
 */
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
  // A failure of an operation on the listing (a delete, so far) reports here
  // instead of in `remoteError`: the read succeeded, and its rows are what
  // tells the user which entries a failed removal left behind. Kept apart
  // from the error because a directory that could not be read has no rows to
  // keep, so that failure still replaces the list. See FileBrowser.
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

  const [localHome, setLocalHome] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [localDraft, setLocalDraft] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelection, setLocalSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // The local pane's own operation notice; see `remoteNotice`.
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const localView = useRef<DirectoryView>({ path: "", epoch: 0, lifetime: 0, readGeneration: 0 });
  const remoteView = useRef<DirectoryView>({ path: "", epoch: 0, lifetime: 0, readGeneration: 0 });

  const loadRemote = useCallback(
    async (
      target: string,
      quiet = false,
      operationError: string | null = null,
    ): Promise<boolean> => {
      const view = remoteView.current;
      const request = startDirectoryRead(view, target);
      setRemoteLoading(true);
      // A read starts the pane's message over: the directory's own error goes,
      // and an operation that has just finished hands its failure in here so
      // the reload reports it without replacing the rows it loads.
      setRemoteError(null);
      setRemoteNotice(operationError);
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
        if (request === view.pending && !quiet) setRemoteError(friendlyFtpError(error));
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
      operationError: string | null = null,
    ): Promise<boolean> => {
      const view = localView.current;
      const request = startDirectoryRead(view, typeof target === "string" ? target : null);
      setLocalLoading(true);
      // See `loadRemote`: the reload reports an operation's failure beside
      // the rows, while a read failure still takes the error line.
      setLocalError(null);
      setLocalNotice(operationError);
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
        if (request === view.pending && !quiet) setLocalError(errorText(error));
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
          restore(remoteView.current, initialRemote, loadRemote, saved?.filer, ftpHome),
          restore(localView.current, initialLocal, loadLocal, saved?.local, machineHome),
        ]);
      } catch (error) {
        if (!cancelled && remoteView.current.readGeneration === initialRemote) {
          setRemoteError(friendlyFtpError(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      retireDirectoryView(remoteView.current);
      retireDirectoryView(localView.current);
    };
  }, [loadLocal, loadRemote, sessionId, tab.state]);

  const beginDirectoryRefresh: BeginDirectoryRefresh = (side, originalPath, destination) => {
    const view = side === "remote" ? remoteView.current : localView.current;
    const load = side === "remote" ? loadRemote : loadLocal;
    const setNotice = side === "remote" ? setRemoteNotice : setLocalNotice;
    const { epoch, lifetime } = view;
    return async (operationError) => {
      while (view.lifetime === lifetime) {
        const { path, pending } = view;
        const isOriginal = view.epoch === epoch && path === originalPath;
        const canRefresh = isOriginal || path === destination;
        if (!canRefresh && destination === undefined) {
          // The pane has moved on, so there is no listing of `originalPath`
          // left to reload, but the operation still failed. It goes on the
          // view the user is looking at now; returning here without it left a
          // failed delete reported nowhere at all.
          if (operationError !== null) setNotice(operationError);
          return;
        }

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
    setRemoteNotice,
    setLocalNotice,
    loadRemote,
    loadLocal,
    loadLocalParent: () => loadLocal(() => api.localParent(localPath)),
    selectedLocal,
    selectedRemote,
    remoteDraft,
    remoteSelection,
    remoteLoading,
    remoteError,
    remoteNotice,
    setRemoteDraft,
    remoteHome,
    setRemoteSelection,
    localLoading,
    localDraft,
    localSelection,
    localError,
    localNotice,
    setLocalDraft,
    localHome,
    setLocalSelection,
  };
}
