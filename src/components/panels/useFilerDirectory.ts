import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import * as api from "../../api";
import { useStore } from "../../store";
import type { FileEntry } from "../../types";
import { useStableCallback } from "../../useStableCallback";
import {
  LOCAL_SOURCE,
  lastPaths,
  listingCache,
  listingKey,
  rememberListing,
  rememberPath,
  sameListing,
} from "./filerDirectoryCache";
import { remoteParent } from "./filerPresentation";
import { NewEntryDraft } from "./filerTypes";

interface Options {
  offline: boolean;
  remoteId: string | null;
  clearSelection: () => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPath: Dispatch<SetStateAction<string>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setEntries: Dispatch<SetStateAction<FileEntry[]>>;
  setCreating: Dispatch<SetStateAction<NewEntryDraft | null>>;
  path: string;
}

export function useFilerDirectory({
  offline,
  remoteId,
  clearSelection,
  setBusy,
  setError,
  setPath,
  setDraft,
  setEntries,
  setCreating,
  path,
}: Options) {
  const remoteIdRef = useRef(remoteId);
  remoteIdRef.current = remoteId;
  const filerTarget = useStore((s) => s.filerTarget);
  /** The last `filerTarget.token` this panel navigated to. */
  const consumedTarget = useRef(0);
  const listRequest = useRef(0);

  /**
   * Lists `target` and shows it. Resolves false if the listing failed; the
   * error is shown unless `quiet`, for a caller that has a fallback.
   */
  const load = useCallback(
    async (target: string, quiet = false, resume = false): Promise<boolean> => {
      if (offline || remoteIdRef.current !== remoteId) return false;
      const request = ++listRequest.current;
      clearSelection();
      setBusy(true);
      setError(null);
      // Only when coming back to a session: a refresh after a rename, delete
      // or upload must not flash the rows as they were before it. `busy`
      // stays set meanwhile, so the cached rows read as loading.
      const cached =
        resume && remoteId ? listingCache.get(listingKey(remoteId, target)) : undefined;
      if (cached) {
        setPath(target);
        setDraft(target);
        setEntries(cached);
      }
      try {
        const listing = remoteId
          ? await api.sftpList(remoteId, target)
          : await api.localList(target);
        // The user switched sessions while this was listing; showing it now
        // would put the previous session's files under the new one.
        if (remoteIdRef.current !== remoteId || request !== listRequest.current) return false;
        setPath(listing.path);
        setDraft(listing.path);
        // Same rows as the cached ones already on screen: keep that array, so
        // nothing re-sorts or re-renders for an unchanged directory.
        setEntries(cached && sameListing(cached, listing.entries) ? cached : listing.entries);
        if (remoteId) rememberListing(remoteId, target, listing.path, listing.entries);
        rememberPath(remoteId ?? LOCAL_SOURCE, listing.path);
        return true;
      } catch (e) {
        if (!quiet && request === listRequest.current && remoteIdRef.current === remoteId)
          setError(String(e));
        return false;
      } finally {
        if (request === listRequest.current && remoteIdRef.current === remoteId) setBusy(false);
      }
    },
    [remoteId, offline, clearSelection, setBusy, setError, setPath, setDraft, setEntries],
  );

  /**
   * A reveal request not yet navigated to, if it is for the session this
   * panel is showing. Claimed on return, so the mount-time load below and
   * the effect watching `filerTarget` never both act on one request.
   */
  const claimTarget = useStableCallback((): string | null => {
    const target = useStore.getState().filerTarget;
    if (!target || target.token === consumedTarget.current) return null;
    consumedTarget.current = target.token;
    const tabId = useStore.getState().activeId;
    return target.sessionId === tabId ? target.path : null;
  });

  useEffect(() => {
    if (offline) {
      setPath("");
      setDraft("");
      setEntries([]);
      clearSelection();
      setCreating(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Revealing with the panel hidden shows it: start at the requested
        // directory rather than loading home first and racing it.
        const target = claimTarget();
        if (target !== null) {
          await load(target);
          return;
        }
        // Coming back to a session resumes where it was browsed; home only
        // the first time, or when that directory no longer lists.
        const last = lastPaths.get(remoteId ?? LOCAL_SOURCE);
        if (last !== undefined && (await load(last, true, true))) return;
        if (cancelled) return;
        const home = remoteId ? await api.sftpHome(remoteId) : await api.localHome();
        if (!cancelled) await load(home);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    remoteId,
    offline,
    load,
    clearSelection,
    setCreating,
    setEntries,
    setPath,
    setDraft,
    setError,
  ]);

  useEffect(() => {
    const target = claimTarget();
    if (target !== null) void load(target);
  }, [filerTarget, load]);

  const goUp = async () => {
    if (!path) return;
    const parent = remoteId ? remoteParent(path) : await api.localParent(path);
    await load(parent);
  };

  return { load, goUp };
}
