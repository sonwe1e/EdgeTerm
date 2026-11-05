import type { Dispatch, SetStateAction } from "react";
import { errorText } from "../../errorInfo";
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
import { getLocalFilerPath } from "../../workspaceDirectories";

/** Why a directory is being listed; only a manual navigation pauses following. */
type LoadReason = "manual" | "follow" | "resume";

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
  const activeId = useStore((s) => s.activeId);
  /** The last `filerTarget.token` this panel navigated to. */
  const consumedTarget = useRef(0);
  const listRequest = useRef(0);
  const refreshRequest = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Background completion updates rows without changing navigation, selection or errors. */
  const refresh = useStableCallback(async (sessionId: string, target: string) => {
    if (offline || remoteId !== sessionId || pathRef.current !== target) return;
    const request = listRequest.current;
    const refreshId = ++refreshRequest.current;
    try {
      const listing = await api.sftpList(sessionId, target);
      if (
        !alive.current ||
        remoteIdRef.current !== sessionId ||
        pathRef.current !== target ||
        refreshId !== refreshRequest.current ||
        request !== listRequest.current
      )
        return;
      setEntries((previous) =>
        sameListing(previous, listing.entries) ? previous : listing.entries,
      );
      rememberListing(sessionId, target, listing.path, listing.entries);
    } catch {
      // A background refresh must not replace an actionable transfer error.
    }
  });

  /**
   * Lists `target` and shows it. Resolves false if the listing failed; the
   * error is shown unless `quiet`, for a caller that has a fallback.
   */
  const load = useCallback(
    async (
      target: string,
      quiet = false,
      resume = false,
      reason: LoadReason = "manual",
    ): Promise<boolean> => {
      if (offline || remoteIdRef.current !== remoteId) return false;
      // Browsing by hand takes the wheel from the follow: the next `cd` must
      // not yank the panel back. Reloading the directory already shown
      // (refresh, rename, upload) is not navigation, and neither a follow nor
      // a resume load is the user choosing where to go.
      if (reason === "manual" && target !== pathRef.current) {
        const sessionId = remoteIdRef.current ?? useStore.getState().activeId;
        if (sessionId !== null) useStore.getState().pauseFilerFollow(sessionId);
      }
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
          setError(errorText(e));
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
        // directory rather than loading home first and racing it. A reveal is
        // not the user browsing, so it does not pause a follow.
        const target = claimTarget();
        if (target !== null) {
          await load(target, false, false, "follow");
          return;
        }
        // A followed session catches up with the shell's current directory:
        // the reports that arrived while the panel was closed were not acted
        // on. The panel is on screen now, so this is one listing, not a poll.
        const shown = useStore.getState().activeId;
        const followed =
          shown === null ? null : await useStore.getState().resolveFilerFollow(shown);
        if (cancelled) return;
        if (followed !== null && (await load(followed, true, true, "follow"))) return;
        if (cancelled) return;
        // Coming back to a session resumes where it was browsed; home only
        // the first time, or when that directory no longer lists.
        const last =
          (remoteId
            ? useStore.getState().tabs.find((tab) => tab.info.id === remoteId)?.directories?.filer
            : getLocalFilerPath()) ?? lastPaths.get(remoteId ?? LOCAL_SOURCE);
        if (last !== undefined && (await load(last, true, true, "resume"))) return;
        if (cancelled) return;
        const home = remoteId ? await api.sftpHome(remoteId) : await api.localHome();
        if (!cancelled) await load(home, false, false, "resume");
      } catch (e) {
        if (!cancelled) setError(errorText(e));
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
    if (target !== null) void load(target, false, false, "follow");
  }, [filerTarget, load]);

  /**
   * The Filer follows the session it shows, and only that one: reports that
   * arrived while another tab held the screen were deliberately ignored. A
   * followed session catches up here when it is shown again — one listing,
   * no polling. A source change (to an SSH tab, to the local file system) is
   * the effect above's job and is left to it.
   */
  const shownSession = useRef<{ session: string | null; source: string } | null>(null);
  useEffect(() => {
    const source = remoteId ?? LOCAL_SOURCE;
    const previous = shownSession.current;
    shownSession.current = { session: activeId, source };
    if (offline || activeId === null || previous === null) return;
    if (previous.source !== source || previous.session === activeId) return;
    const session: string = activeId;
    let cancelled = false;
    void (async () => {
      const followed = await useStore.getState().resolveFilerFollow(session);
      if (!cancelled && followed !== null) await load(followed, true, true, "follow");
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, remoteId, offline, load]);

  const goUp = async () => {
    if (!path) return;
    try {
      // The one navigation whose target the front end cannot compute itself:
      // a Windows drive root's parent is the virtual drive list, and only the
      // backend knows where a mount point's parent is. A rejection used to be
      // dropped by the caller's `void`, so the button did nothing at all.
      const parent = remoteId ? remoteParent(path) : await api.localParent(path);
      await load(parent);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** The session's home directory, the way the dual-pane browsers' Home works. */
  const goHome = async () => {
    try {
      const home = remoteId ? await api.sftpHome(remoteId) : await api.localHome();
      await load(home);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return { load, goUp, goHome, refresh };
}
