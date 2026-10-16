import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { revealCwdInFiler } from "../../actions";
import * as api from "../../api";
import { useFileTransfers } from "../../fileTransfers";
import {
  sortFileEntries,
  toggleFileSort,
  type SortKey,
} from "../../fileSort";
import { t as translateMsg, type Translate } from "../../i18n";
import { open as openDialog, save as saveDialog } from "../../nativeDialog";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import { FILER_OPEN_WITH_KEY } from "../../persistKeys";
import { chordLabel } from "../../shortcuts";
import { tabTitle, useActiveTab, useStore } from "../../store";
import { useStableCallback } from "../../useStableCallback";
import { useFileSelection } from "../../useFileSelection";
import { useT } from "../../useT";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { DeleteEntryDialog } from "../DeleteEntryDialog";
import { FileIcon } from "../FileIcon";
import { Icon } from "../icons";
import { SortIndicator } from "../SortIndicator";
import { VirtualFileRows } from "../VirtualFileRows";
import type { FileEntry, ThemeMode } from "../../types";

interface TransferState {
  /**
   * `sync` is a remote file edited locally being sent back after a save;
   * `stage` is the copy a drag out of the window needs on Windows / Linux
   * before the system can take it (macOS downloads on the drop instead,
   * shown as a `download`); `copy` is a drop landing in a local folder.
   */
  kind: "upload" | "download" | "sync" | "stage" | "copy";
  name: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  status: "running" | "complete" | "error" | "cancelled";
  /** Whether the footer offers to cancel it; see `beginTransfer`. */
  cancellable: boolean;
}

interface TransferRateSample {
  time: number;
  transferred: number;
}

/** The transfer that can be cancelled right now; see `beginTransfer`. */
interface ActiveTransfer {
  id: string;
  /** Set once a cancel was sent, so the rejection reads as a cancel. */
  cancelled: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** An entry on its way out of the window; `staging` while its copy downloads. */
interface DragOutState {
  path: string;
  name: string;
  /**
   * True while the copy a Windows / Linux drag needs is still downloading,
   * before the system has the drag; a release then cancels it.
   */
  staging: boolean;
}

/** A press on an entry that has not yet travelled far enough to be a drag. */
interface DragPress {
  pointerId: number;
  x: number;
  y: number;
  entry: FileEntry;
}

/** Pointer travel before a press on an entry turns into a drag out. */
const DRAG_OUT_THRESHOLD = 5;

/**
 * Whether a drop on the panel would be uploaded. `reason` carries the message
 * to show when it would not; null means say nothing (this panel's own drag
 * out is passing over the window).
 */
interface DropVerdict {
  accept: boolean;
  reason: string | null;
}

/**
 * Where a drag currently is, in CSS pixels, so it can be compared with the
 * panel's own `getBoundingClientRect()`.
 *
 * Tauri types the position as physical, but only Windows measures it that
 * way: wry reads the client point from `ScreenToClient`. macOS passes
 * AppKit's `draggingLocation` and Linux the widget coordinates of GTK's
 * `drag-motion` straight through, and both of those are already logical
 * points. Dividing them by the device pixel ratio put every drop at half its
 * real position, which on a Retina display is far to the left of the Filer —
 * the panel never saw a drop and nothing was ever uploaded.
 */
const dropPoint = (position: PhysicalPosition): { x: number; y: number } =>
  IS_WINDOWS ? position.toLogical(window.devicePixelRatio) : position;

/** `lastPaths` key for the local file system, which every local tab shares. */
const LOCAL_SOURCE = "";

/**
 * The directory last shown for each source (a remote session id, or
 * `LOCAL_SOURCE`), so switching back to a session returns to where the user
 * was browsing instead of its home (issue #74). Module level so hiding the
 * panel keeps it too; entries for closed sessions are pruned as others are
 * recorded.
 */
const lastPaths = new Map<string, string>();

/**
 * The last listing of each remote directory, shown while a fresh one is on its
 * way (stale-while-revalidate). Switching back to an SSH tab used to leave the
 * panel on the previous session's rows until a full SFTP round trip and a JSON
 * parse of the directory finished. Local listings are not cached: they are
 * cheap and the disk is the source of truth. Bounded, oldest dropped first.
 */
const LISTING_CACHE_LIMIT = 24;
const listingCache = new Map<string, FileEntry[]>();
const listingKey = (source: string, path: string) => `${source}\u0000${path}`;

const rememberListing = (source: string, requested: string, path: string, entries: FileEntry[]) => {
  for (const key of new Set([listingKey(source, requested), listingKey(source, path)])) {
    listingCache.delete(key);
    listingCache.set(key, entries);
  }
  while (listingCache.size > LISTING_CACHE_LIMIT) {
    listingCache.delete(listingCache.keys().next().value as string);
  }
};

/** Whether a fresh listing shows the same rows as the one on screen. */
export const sameListing = (a: readonly FileEntry[], b: readonly FileEntry[]) =>
  a.length === b.length &&
  a.every((entry, i) => {
    const other = b[i];
    return (
      entry.path === other.path &&
      entry.size === other.size &&
      entry.modified === other.modified &&
      entry.isDir === other.isDir &&
      entry.permissions === other.permissions
    );
  });

const rememberPath = (source: string, path: string) => {
  const open = new Set(useStore.getState().tabs.map((tab) => tab.info.id));
  for (const key of lastPaths.keys()) {
    if (key !== LOCAL_SOURCE && !open.has(key)) lastPaths.delete(key);
  }
  lastPaths.set(source, path);
};

function FilerPanelBase() {
  const t = useT();
  const tab = useActiveTab();
  const theme = useStore((s) => s.theme);
  const sshFiles = Boolean(
    tab?.info.kind === "ssh" && tab.info.supportsRemoteFiles,
  );
  const remote = sshFiles && tab?.state === "connected";
  // An SSH session that is still connecting or has dropped shows no files at
  // all. Falling back to the local home made a drop meant for the server copy
  // into this machine instead (issue #71).
  const offline = sshFiles && !remote;
  const offlineReason = offline
    ? tab?.state === "connecting"
      ? t("session.connecting")
      : t("filer.offline")
    : null;
  // Null for every session without remote files, so switching between local tabs does not
  // count as a source change and reset where the user was browsing.
  const remoteId = remote ? (tab?.info.id ?? null) : null;
  const filerTarget = useStore((s) => s.filerTarget);
  const revealKey = useStore((s) => chordLabel(s.shortcuts.revealCwd));
  /** The last `filerTarget.token` this panel navigated to. */
  const consumedTarget = useRef(0);
  // Shell and SSH sessions have a working directory to reveal (⌘J); file
  // sessions bring their own pane and serial lines have no shell.
  const canReveal = Boolean(
    tab &&
      (tab.info.kind === "local" || tab.info.kind === "ssh") &&
      tab.state === "connected",
  );

  const [path, setPath] = useState("");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // The sort lives in the store so the Filer and both dual-pane browsers
  // follow one choice as it changes, instead of each reading the stored
  // preference once at mount and drifting apart.
  const sort = useStore((s) => s.filerSort);
  const setFilerSort = useStore((s) => s.setFilerSort);
  const sortedEntries = useMemo(() => sortFileEntries(entries, sort), [entries, sort]);
  const selection = useFileSelection(sortedEntries);
  const { paths: selected, selectedEntries, clear: clearSelection, select: selectEntry } = selection;
  const collapseSelection = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<NewEntryDraft | null>(null);
  const [uploadMenu, setUploadMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // ContextMenu closes itself on any outside mousedown, so by the time the
  // upload button's click fires the menu is already gone; remember whether it
  // was open so the button toggles instead of reopening.
  const uploadMenuWasOpen = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<readonly FileEntry[] | null>(null);
  useEffect(() => setPendingDelete(null), [remoteId, path]);
  const [openWithApps, setOpenWithApps] = useState<string[]>(loadOpenWithApps);
  const preferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setOpenWithApps(loadOpenWithApps()), [preferencesRevision]);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [dragOver, setDragOver] = useState<DropVerdict | null>(null);
  const [dragOut, setDragOut] = useState<DragOutState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const remoteIdRef = useRef(remoteId);
  const offlineReasonRef = useRef(offlineReason);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);
  const dropFilesRef = useRef<(paths: string[]) => void>(() => {});
  /** Read from the drop handler, which must not act during our own drag. */
  const dragOutRef = useRef<DragOutState | null>(null);
  /**
   * What the last drag out handed to the system. A drop carrying exactly
   * those paths is that drag coming back over this window, and uploading it
   * would send the copy straight back to where it came from. Matching on the
   * paths rather than on "a drag is in flight" keeps a drag whose end was
   * never reported from blocking every later upload.
   */
  const handedOutPaths = useRef<string[]>([]);
  /** Whether the button that started a drag out is still held down. */
  const pointerHeld = useRef(false);
  const dragPress = useRef<DragPress | null>(null);
  const remoteEditRef = useRef<(event: api.RemoteEditEvent) => void>(() => {});
  const transferClearTimer = useRef<number | null>(null);
  const transferRateSamples = useRef<TransferRateSample[]>([]);
  const activeTransfer = useRef<ActiveTransfer | null>(null);
  const visibleTransferId = useRef<string | undefined>(undefined);
  const ownsTransfer = (id: string | undefined) => visibleTransferId.current === id;
  const backgroundTransfer = useFileTransfers((s) => s.jobs[activeTransfer.current?.id ?? ""]);
  const listRequest = useRef(0);

  remoteIdRef.current = remoteId;
  offlineReasonRef.current = offlineReason;
  pathRef.current = path;
  busyRef.current = busy;

  /**
   * Shows `kind` starting in the footer. A cancellable transfer (the SFTP
   * and FTP copies) gets the id to pass along; the footer's Cancel button
   * and a released drag reach it through `cancelTransfer`.
   */
  const beginTransfer = (
    kind: TransferState["kind"],
    name: string,
    cancellable = false,
  ): string | undefined => {
    if (transferClearTimer.current !== null) {
      window.clearTimeout(transferClearTimer.current);
      transferClearTimer.current = null;
    }
    activeTransfer.current = cancellable
      ? { id: api.newTransferId(), cancelled: false }
      : null;
    visibleTransferId.current = activeTransfer.current?.id;
    setTransfer({
      kind,
      name,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      status: "running",
      cancellable,
    });
    transferRateSamples.current = [
      { time: performance.now(), transferred: 0 },
    ];
    return activeTransfer.current?.id;
  };

  const updateTransferProgress = (progress: api.TransferProgress) => {
    const now = performance.now();
    const samples = transferRateSamples.current;
    const latest = samples[samples.length - 1];
    if (!latest || progress.transferred < latest.transferred) {
      samples.splice(0, samples.length, {
        time: now,
        transferred: progress.transferred,
      });
    } else if (
      progress.transferred !== latest.transferred ||
      now - latest.time >= 250
    ) {
      samples.push({ time: now, transferred: progress.transferred });
    }

    const cutoff = now - 1000;
    while (samples.length > 2 && samples[1].time <= cutoff) {
      samples.shift();
    }
    const oldest = samples[0];
    const elapsedSeconds = oldest ? (now - oldest.time) / 1000 : 0;
    const bytesPerSecond =
      oldest && elapsedSeconds > 0
        ? Math.max(
            0,
            (progress.transferred - oldest.transferred) / elapsedSeconds,
          )
        : 0;

    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond,
          }
        : current,
    );
  };

  const progressFor = (id: string | undefined) => (progress: api.TransferProgress) => {
    if (ownsTransfer(id)) updateTransferProgress(progress);
  };

  const finishTransfer = (status: "complete" | "error" | "cancelled", id = visibleTransferId.current) => {
    if (!ownsTransfer(id)) return;
    activeTransfer.current = null;
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred:
              status === "complete" && current.total > 0
                ? current.total
                : current.transferred,
            status,
          }
        : current,
    );
    transferClearTimer.current = window.setTimeout(
      () => {
        setTransfer(null);
        transferClearTimer.current = null;
      },
      status === "error" ? 3000 : 1800,
    );
  };

  /**
   * Cancels the transfer in the footer. The backend stops within a chunk
   * and the transfer's promise rejects, which `failTransfer` then reads as
   * a cancel rather than a failure.
   */
  const cancelTransfer = useStableCallback(() => {
    const active = activeTransfer.current;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    void api.cancelTransfer(active.id);
  });

  /** Ends the transfer a rejection belongs to: cancelled, or failed with `e`. */
  const failTransfer = (e: unknown, id = visibleTransferId.current) => {
    if (!ownsTransfer(id)) return;
    if (activeTransfer.current?.cancelled || String(e).includes("transfer cancelled")) {
      finishTransfer("cancelled");
      return;
    }
    setError(String(e));
    finishTransfer("error");
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  /**
   * Lists `target` and shows it. Resolves false if the listing failed; the
   * error is shown unless `quiet`, for a caller that has a fallback.
   */
  const load = useCallback(
    async (target: string, quiet = false, resume = false): Promise<boolean> => {
      if (offline || remoteIdRef.current !== remoteId) return false;
      const request = ++listRequest.current;
      clearSelection();
      collapseSelection.current = null;
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
        if (!quiet && request === listRequest.current && remoteIdRef.current === remoteId) setError(String(e));
        return false;
      } finally {
        if (request === listRequest.current && remoteIdRef.current === remoteId) setBusy(false);
      }
    },
    [remoteId, offline, clearSelection],
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
        const home = remoteId
          ? await api.sftpHome(remoteId)
          : await api.localHome();
        if (!cancelled) await load(home);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteId, offline, load, clearSelection]);

  useEffect(() => {
    const target = claimTarget();
    if (target !== null) void load(target);
  }, [filerTarget, load]);

  useEffect(
    () => () => {
      if (transferClearTimer.current !== null) {
        window.clearTimeout(transferClearTimer.current);
      }
    },
    [],
  );

  const goUp = async () => {
    if (!path) return;
    const parent = remoteId ? remoteParent(path) : await api.localParent(path);
    await load(parent);
  };

  const download = async (entry: FileEntry) => {
    if (!remoteId) return;
    let target: string | null = null;
    if (entry.isDir) {
      // A folder lands inside the chosen directory under its own name, so an
      // existing folder of that name is merged into rather than replaced.
      const parent = await openDialog({
        directory: true,
        multiple: false,
        title: t("filer.saveFolderInto", { name: entry.name }),
      });
      if (typeof parent === "string") target = joinLocal(parent, entry.name);
    } else {
      target = await saveDialog({ defaultPath: entry.name });
    }
    if (!target) return;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    try {
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          remoteId,
          entry.path,
          target,
          progressFor(transfer),
          transfer,
        );
      } else {
        await api.sftpDownload(
          remoteId,
          entry.path,
          target,
          progressFor(transfer),
          transfer,
        );
      }
      finishTransfer("complete", transfer);
    } catch (e) {
      failTransfer(e, transfer);
    } finally {
      if (ownsTransfer(transfer)) setBusy(false);
    }
  };

  const downloadEntries = async (chosen: readonly FileEntry[]) => {
    if (chosen.length === 1) return download(chosen[0]);
    const sessionId = remoteId;
    if (!sessionId || chosen.length === 0 || busyRef.current) return;
    const parent = await openDialog({ directory: true, multiple: false, title: t("filer.saveSelectedInto") });
    if (typeof parent !== "string" || remoteIdRef.current !== sessionId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", t("filer.selectedCount", { count: chosen.length }), true);
    try {
      await api.transferFiles(sessionId, chosen.map((entry) => ({
        local: joinLocal(parent, entry.name), remote: entry.path, upload: false, directory: entry.isDir,
      })), progressFor(transfer), transfer);
      finishTransfer("complete", transfer);
    } catch (e) {
      failTransfer(e, transfer);
    } finally {
      if (ownsTransfer(transfer)) { busyRef.current = false; setBusy(false); }
    }
  };

  const uploadPaths = async (localPaths: string[]) => {
    if (!remoteId || !path || busyRef.current || localPaths.length === 0) {
      return;
    }
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("upload", localPaths.length === 1 ? localFileName(localPaths[0]) : `${localPaths.length} items`, true);
    try {
      const items: api.TransferItem[] = localPaths.map((localPath) => ({
        local: localPath, remote: joinRemote(destination, localFileName(localPath)),
        upload: true,
      }));
      await api.transferFiles(remoteId, items, progressFor(transfer), transfer);
      finishTransfer("complete", transfer);
      await load(destination);
    } catch (e) {
      // Reload first: it clears the error line, and what did arrive should
      // show.
      await load(destination);
      failTransfer(e, transfer);
    } finally {
      if (ownsTransfer(transfer)) busyRef.current = false;
      if (ownsTransfer(transfer)) setBusy(false);
    }
  };

  /**
   * Files dropped on a Filer that is showing local files land in the folder
   * on screen, the way dropping on a file manager works: uploading needs a
   * remote session, and this is the local half of the same gesture.
   */
  const copyPaths = async (sources: string[]) => {
    if (
      remoteIdRef.current ||
      offlineReasonRef.current ||
      !path ||
      busyRef.current ||
      sources.length === 0
    ) {
      return;
    }
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let skipped = 0;
    try {
      for (const source of sources) {
        beginTransfer("copy", localFileName(source));
        const summary = await api.localCopyInto(
          source,
          destination,
          updateTransferProgress,
        );
        if (summary.files === 0 && summary.skipped > 0) skipped += 1;
        finishTransfer("complete");
      }
      await load(destination);
      if (skipped > 0) {
        setError(
          skipped === sources.length
            ? t("filer.alreadyHere")
            : t("filer.someAlready", {
                skipped,
                total: sources.length,
              }),
        );
      }
    } catch (e) {
      finishTransfer("error");
      await load(destination);
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  dropFilesRef.current = (paths) => {
    if (remoteId) void uploadPaths(paths);
    else void copyPaths(paths);
  };

  const updateDragOut = useStableCallback((next: DragOutState | null) => {
    dragOutRef.current = next;
    setDragOut(next);
  });

  /**
   * Whether files dropped on the panel right now would be uploaded, and what
   * to tell the user when they would not. A refusal without a reason is this
   * panel's own drag passing over the window, which says nothing.
   */
  const dropVerdict = useStableCallback((): DropVerdict => {
    if (dragOutRef.current) return { accept: false, reason: null };
    if (offlineReasonRef.current) {
      return { accept: false, reason: offlineReasonRef.current };
    }
    if (!pathRef.current) {
      return { accept: false, reason: t("filer.noFolderOpen") };
    }
    // The Windows drive list is a virtual folder: drives can be opened but
    // nothing can be written next to them.
    if (!remoteIdRef.current && pathRef.current === api.LOCAL_DRIVES_ROOT) {
      return { accept: false, reason: t("filer.openDrive") };
    }
    if (busyRef.current) {
      return {
        accept: false,
        reason: t("filer.busy"),
      };
    }
    return { accept: true, reason: null };
  });

  /**
   * Hands local paths to the system, which carries them until the user drops
   * them on a folder, the desktop or another application. The gesture the
   * drag attaches to is the one still in progress, so this runs while the
   * button is down; the callback lands when it is released.
   */
  const handToSystem = async (entry: FileEntry, paths: string[]) => {
    handedOutPaths.current = paths;
    updateDragOut({ path: entry.path, name: entry.name, staging: false });
    try {
      await api.startFileDrag(paths, (outcome) => {
        updateDragOut(null);
        if (outcome.error) {
          setError(
            t("filer.couldNotDrag", { name: entry.name, error: outcome.error }),
          );
        }
      });
    } catch (e) {
      updateDragOut(null);
      setError(String(e));
    }
  };

  /**
   * macOS: hands the system a promise of `entry` rather than a copy of it.
   * Nothing is downloaded while the drag is in flight; a target that takes
   * the drop (Finder, the desktop, another application) names the path it
   * wants, and `deliverPromised` downloads straight there. A drag that is
   * cancelled or let go inside the window costs nothing.
   */
  const promiseToSystem = async (sessionId: string, entry: FileEntry) => {
    updateDragOut({ path: entry.path, name: entry.name, staging: false });
    try {
      await api.startPromisedFileDrag(entry.name, entry.isDir, (event) => {
        switch (event.kind) {
          case "write":
            void deliverPromised(
              sessionId,
              entry,
              event.token,
              event.destination,
            );
            break;
          case "ended":
            updateDragOut(null);
            break;
          case "failed":
            updateDragOut(null);
            setError(
              t("filer.couldNotDrag", { name: entry.name, error: event.error }),
            );
            break;
        }
      });
    } catch (e) {
      updateDragOut(null);
      setError(String(e));
    }
  };

  /**
   * Downloads a promised entry to where the drop target asked for it, then
   * settles the promise so the target shows the file (or the reason there
   * is none). The transfer is the ordinary cancellable download; a cancel
   * is reported to the target like any other failure.
   */
  const deliverPromised = async (
    sessionId: string,
    entry: FileEntry,
    token: string,
    destination: string,
  ) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    let failure: string | null = null;
    try {
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          entry.path,
          destination,
          progressFor(transfer),
          transfer,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          entry.path,
          destination,
          progressFor(transfer),
          transfer,
        );
      }
      finishTransfer("complete", transfer);
    } catch (e) {
      failure = activeTransfer.current?.cancelled
        ? t("filer.downloadCancelled", { name: entry.name })
        : String(e);
      failTransfer(e, transfer);
    } finally {
      if (ownsTransfer(transfer)) busyRef.current = false;
      if (ownsTransfer(transfer)) setBusy(false);
    }
    try {
      await api.finishPromisedFile(token, failure);
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * Drags `entry` out of the window. A local entry is already a file the
   * system can take. One remote entry is promised on macOS. Other remote
   * gestures stage the complete selection before handing it to the system,
   * so the downloads must finish while the button is held.
   */
  const beginDragOut = async (entry: FileEntry) => {
    if (busyRef.current || dragOutRef.current || atDrivesRoot) return;
    const chosen = selected.has(entry.path) ? selectedEntries : [entry];
    const sessionId = remoteIdRef.current;
    if (!sessionId) {
      await handToSystem(entry, chosen.map((item) => item.path));
      return;
    }
    if (IS_MAC && chosen.length === 1) {
      await promiseToSystem(sessionId, entry);
      return;
    }

    updateDragOut({ path: entry.path, name: entry.name, staging: true });
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("stage", chosen.length === 1 ? entry.name
      : t("filer.selectedCount", { count: chosen.length }), true);
    try {
      const staged = await Promise.all(chosen.map(async (item) => ({
        local: await api.dragStagingPath(item.name), remote: item.path,
        upload: false, directory: item.isDir,
      })));
      if (chosen.length > 1) {
        await api.transferFiles(sessionId, staged, progressFor(transfer), transfer);
      } else if (entry.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          entry.path,
          staged[0].local,
          progressFor(transfer),
          transfer,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          entry.path,
          staged[0].local,
          progressFor(transfer),
          transfer,
        );
      }
      finishTransfer("complete", transfer);
      if (pointerHeld.current) {
        await handToSystem(entry, staged.map((item) => item.local));
      } else {
        // The release cancels a copy still running (see `release`); this is
        // the copy that finished just before the release was seen.
        updateDragOut(null);
        setError(t("filer.dragEnded", { name: entry.name }));
      }
    } catch (e) {
      updateDragOut(null);
      failTransfer(e, transfer);
    } finally {
      if (ownsTransfer(transfer)) busyRef.current = false;
      if (ownsTransfer(transfer)) setBusy(false);
    }
  };

  const onEntryPointerDown = (
    entry: FileEntry,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    pointerHeld.current = true;
    dragPress.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      entry,
    };
    // Without the capture a quick flick leaves the row before the threshold
    // is reached and the drag never starts.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onEntryPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = dragPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - press.x) < DRAG_OUT_THRESHOLD &&
      Math.abs(event.clientY - press.y) < DRAG_OUT_THRESHOLD
    ) {
      return;
    }
    dragPress.current = null;
    collapseSelection.current = null;
    // The system drag needs the pointer itself; a capture would keep every
    // event inside the webview.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void beginDragOut(press.entry);
  };

  // The release may land anywhere — outside the row, outside the window —
  // and staging needs to know whether the gesture is still alive.
  useEffect(() => {
    const release = (event: Event) => {
      if (event.type === "pointerup" && collapseSelection.current && dragPress.current) {
        selectEntry(collapseSelection.current);
      }
      collapseSelection.current = null;
      pointerHeld.current = false;
      dragPress.current = null;
      // A drag that ends while its copy is still downloading was never
      // going to drop anything: an accidental few pixels of travel used to
      // download a whole folder that nobody could stop (#45).
      if (dragOutRef.current?.staging) cancelTransfer();
    };
    // A fresh press means any earlier system drag is long over, whether or
    // not its end was ever reported back.
    const press = () => {
      if (dragOutRef.current) updateDragOut(null);
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [selectEntry]);

  // Progress of remote files edited locally, whichever tab is active: the
  // footer shows the save going out, and a failure lands in the error line.
  remoteEditRef.current = (event) => {
    if (activeTransfer.current) return;
    if (event.status === "uploading") {
      beginTransfer("sync", event.name);
    } else if (event.status === "synced") {
      finishTransfer("complete");
    } else if (event.status === "kept") {
      setError(
        t("filer.remoteEditKept", {
          name: event.name,
          message: event.message ?? t("filer.localCopyKept"),
        }),
      );
    } else {
      setError(
        t("filer.remoteEditSync", {
          name: event.name,
          message: event.message ?? t("filer.syncFailed"),
        }),
      );
      finishTransfer("error");
    }
  };

  useEffect(() => {
    const unlisten = api.onRemoteEditState((event) =>
      remoteEditRef.current(event),
    );
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setDragOver(null);
        return;
      }

      const position = dropPoint(payload.position);
      const bounds = panelRef.current?.getBoundingClientRect();
      const isOverPanel = Boolean(
        bounds &&
          position.x >= bounds.left &&
          position.x <= bounds.right &&
          position.y >= bounds.top &&
          position.y <= bounds.bottom,
      );
      if (!isOverPanel) {
        setDragOver(null);
        return;
      }
      const verdict = dropVerdict();

      if (payload.type === "drop") {
        setDragOver(null);
        if (payload.paths.length === 0) return;
        // Our own drag out coming back over the window: dropping it here
        // would upload the copy it was just made from.
        const ours = payload.paths.every((dropped) =>
          handedOutPaths.current.includes(dropped),
        );
        if (ours) return;
        if (verdict.accept) dropFilesRef.current(payload.paths);
        // Never swallow a drop in silence; say why it was not taken.
        else if (verdict.reason) setError(verdict.reason);
        return;
      }

      setDragOver(verdict);
    });
    void unlisten.catch(() => {});
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (busy) setDragOver(null);
  }, [busy]);

  const upload = async () => {
    if (!remoteId) return;
    const picked = await openDialog({ multiple: true });
    await uploadPaths(pickedPaths(picked));
  };

  const uploadFolder = async () => {
    if (!remoteId) return;
    const picked = await openDialog({ directory: true, multiple: true });
    await uploadPaths(pickedPaths(picked));
  };

  const removeEntries = async (chosen: readonly FileEntry[]) => {
    setPendingDelete(null);
    const sessionId = remoteId;
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const failed: { entry: FileEntry; error: unknown }[] = [];
    try {
      for (const entry of chosen) {
        try {
          if (sessionId) await api.sftpRemove(sessionId, entry.path, entry.isDir);
          else await api.localRemove(entry.path, entry.isDir);
        } catch (error) {
          failed.push({ entry, error });
        }
      }
      if (remoteIdRef.current === sessionId && pathRef.current === destination) await load(destination);
      if (remoteIdRef.current === sessionId && pathRef.current === destination && failed.length) {
        selection.replace(failed.map(({ entry }) => entry.path));
        setError(failed.map(({ entry, error }) => `${entry.name}: ${String(error)}`).join("\n"));
      }
    } finally {
      if (remoteIdRef.current === sessionId && pathRef.current === destination) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch((e) => setError(String(e)));
  };

  /**
   * The local path to hand to an application: the entry itself for local
   * sessions, otherwise a copy downloaded into the temp folder that the
   * backend then watches, sending every save back to the server. Null when
   * the download failed (the error is already shown).
   */
  const localCopyOf = async (entry: FileEntry): Promise<string | null> => {
    if (!remoteId) return entry.path;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    try {
      const target = await api.remoteEditPath(remoteId, entry.path, entry.name);
      await api.sftpDownload(
        remoteId,
        entry.path,
        target,
        progressFor(transfer),
        transfer,
      );
      await api.watchRemoteEdit(remoteId, target, entry.path);
      finishTransfer("complete", transfer);
      return target;
    } catch (e) {
      failTransfer(e, transfer);
      return null;
    } finally {
      if (ownsTransfer(transfer)) setBusy(false);
    }
  };

  /** Opens a file with the default application, or with `app` when given. */
  const openEntry = async (entry: FileEntry, app?: string) => {
    const target = await localCopyOf(entry);
    if (!target) return;
    try {
      await api.openLocalPath(target, app);
      if (app) setOpenWithApps(rememberOpenWithApp(app));
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * A double-click does what the entry's own Open action does: enter a folder,
   * or hand a file to its application (a remote one as a watched local copy).
   */
  const activate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
    else if (!busy) void openEntry(entry);
  };

  /**
   * Lets the user pick the application first. Windows has a system chooser
   * that also knows the registered handlers; elsewhere the application is a
   * file to pick (a macOS `.app` bundle, a program on Linux).
   */
  const openEntryWith = async (entry: FileEntry) => {
    if (IS_WINDOWS) {
      const target = await localCopyOf(entry);
      if (!target) return;
      await api.openWithDialog(target).catch((e) => setError(String(e)));
      return;
    }
    const picked = await openDialog({
      title: t("filer.openWithTitle", { name: entry.name }),
      multiple: false,
      directory: false,
      ...(IS_MAC
        ? {
            defaultPath: "/Applications",
            filters: [{ name: "Applications", extensions: ["app"] }],
          }
        : { defaultPath: "/usr/bin" }),
    });
    if (typeof picked === "string") await openEntry(entry, picked);
  };

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openWithMenu = (entry: FileEntry): MenuItem => {
    const other = {
      label:
        openWithApps.length > 0 ? t("filer.other") : t("filer.openWithEllipsis"),
      disabled: busy,
      action: () => void openEntryWith(entry),
    };
    if (openWithApps.length === 0) return { ...other, icon: "link-external" };
    return {
      label: t("filer.openWithMenu"),
      icon: "link-external",
      children: [
        ...openWithApps.map((app) => ({
          label: appDisplayName(app),
          disabled: busy,
          action: () => void openEntry(entry, app),
        })),
        "separator",
        other,
      ],
    };
  };

  const entryMenu = (entry: FileEntry, chosen: readonly FileEntry[]): MenuItem[] => [
    ...(chosen.length > 1 ? [] : [entry.isDir
      ? {
          label: t("filer.open"),
          icon: "folder-opened" as const,
          action: () => void load(entry.path),
        }
      : {
          label: t("filer.open"),
          icon: "go-to-file" as const,
          disabled: busy,
          action: () => void openEntry(entry),
        },
      ...(entry.isDir ? [] : [openWithMenu(entry)])]),
    ...(remote
      ? [
          {
            label: t("filer.downloadEllipsis"),
            icon: "cloud-download" as const,
            disabled: busy,
            action: () => void downloadEntries(chosen),
          },
        ]
      : []),
    "separator",
    { label: t("filer.copyPath"), icon: "copy", action: () => copyText(chosen.map((item) => item.path).join("\n")) },
    { label: t("filer.copyName"), icon: "tag", action: () => copyText(chosen.map((item) => item.name).join("\n")) },
    "separator",
    {
      label: t("panel.deleteEllipsis"),
      icon: "trash",
      danger: true,
      disabled: busy || atDrivesRoot,
      action: () => setPendingDelete(chosen),
    },
  ];

  /** Menu for the empty part of the list: actions on the current folder. */
  const folderMenu = (): MenuItem[] => [
    {
      label: t("filer.newFile"),
      icon: "new-file",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "file", name: "" }),
    },
    {
      label: t("filer.newFolder"),
      icon: "new-folder",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "folder", name: "" }),
    },
    ...(remote
      ? [
          "separator" as const,
          {
            label: t("filer.uploadFiles"),
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void upload(),
          },
          {
            label: t("filer.uploadFolder"),
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void uploadFolder(),
          },
        ]
      : []),
    "separator",
    {
      label: t("filer.copyFolderPath"),
      icon: "copy",
      disabled: !path || atDrivesRoot,
      action: () => copyText(path),
    },
    {
      label: t("filer.refresh"),
      icon: "refresh",
      disabled: busy,
      action: () => void load(path),
    },
  ];

  const commitNewEntry = async () => {
    const draft = creating;
    setCreating(null);
    const name = draft?.name.trim();
    if (!draft || !name || !path || atDrivesRoot) return;
    const kindWord = draft.kind === "folder" ? t("filer.folder") : t("filer.file");
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setError(t("filer.invalidName", { name, kind: kindWord }));
      return;
    }
    if (entries.some((entry) => entry.name === name)) {
      setError(t("filer.alreadyExists", { name }));
      return;
    }
    try {
      if (remoteId) {
        const target = joinRemote(path, name);
        if (draft.kind === "folder") await api.sftpMkdir(remoteId, target);
        else await api.sftpCreateFile(remoteId, target);
      } else {
        const target = joinLocal(path, name);
        if (draft.kind === "folder") await api.localMkdir(target);
        else await api.localCreateFile(target);
      }
      await load(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(
            100,
            Math.round((transfer.transferred / transfer.total) * 100),
          )
        : null
    : null;
  const transferLabel = transfer
    ? transferLabels(t)[transfer.kind][transfer.status]
    : "";

  const remoteTitle = (label: string) =>
    remote ? label : `${label}${t("filer.sshOnly")}`;
  // The Windows drive list is virtual: drives can be opened but not created,
  // deleted or navigated above.
  const atDrivesRoot = !remoteId && path === api.LOCAL_DRIVES_ROOT;
  const panelFontSize = useStore((s) => s.panelFontSize);
  // The footer walks every entry; a large directory must not pay that on
  // each of the app's re-renders.
  const entrySummary = useMemo(() => formatEntrySummary(entries), [entries]);

  /** Re-sorts the list for a clicked column caption and remembers the choice. */
  const sortBy = (key: SortKey) => {
    setFilerSort(toggleFileSort(useStore.getState().filerSort, key));
  };

  // The row callbacks go through stable identities (see useStableCallback)
  // so a re-render of this panel — a transfer tick, a drag-over change, a
  // selection elsewhere — leaves the memoised rows' props equal and skipped.
  const rowSelect = useStableCallback((path: string, event: MouseEvent) => {
    if (event.button !== 0 || busy) return;
    event.currentTarget.closest<HTMLElement>(".filer-list")?.focus({ preventScroll: true });
    const toggle = IS_MAC ? event.metaKey : event.ctrlKey;
    if (!toggle && !event.shiftKey && selected.size > 1 && selected.has(path)) {
      collapseSelection.current = path;
      return;
    }
    collapseSelection.current = null;
    selectEntry(path, { toggle, range: event.shiftKey });
  });
  const rowActivate = useStableCallback((entry: FileEntry) => activate(entry));
  const rowPointerDown = useStableCallback(
    (entry: FileEntry, event: ReactPointerEvent<HTMLDivElement>) =>
      onEntryPointerDown(entry, event),
  );
  const rowPointerMove = useStableCallback((event: ReactPointerEvent<HTMLDivElement>) =>
    onEntryPointerMove(event),
  );
  const rowContextMenu = useStableCallback(
    (event: MouseEvent, entry: FileEntry) => {
      collapseSelection.current = null;
      const chosen = selected.has(entry.path) ? selectedEntries : [entry];
      if (!selected.has(entry.path)) selectEntry(entry.path);
      openMenu(event, entryMenu(entry, chosen));
    },
  );

  return (
    <div
      ref={panelRef}
      className={`panel filer-panel${dragOver ? (dragOver.accept ? " is-drag-over" : dragOver.reason ? " is-drag-blocked" : "") : ""}`}
      style={{ flex: 1 }}
    >
      <div className="panel-header">
        <div className="panel-title is-filer">
          <Icon name="folder" />
          {t("panel.filer")}
          <span className="panel-badge">
            {remote || offline ? tab?.info.protocol : t("filer.local")}
          </span>
        </div>
      </div>

      {/* Upload and download stay visible on local sessions, just disabled. */}
      <div className="filer-toolbar" role="toolbar" aria-label={t("filer.fileActions")}>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "file", name: "" })}
          title={t("filer.newFileBtn")}
          aria-label={t("filer.newFileBtn")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="new-file" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "folder", name: "" })}
          title={t("filer.newFolderBtn")}
          aria-label={t("filer.newFolderBtn")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="new-folder" />
        </button>
        <button
          className={`panel-action filer-action${uploadMenu ? " is-open" : ""}`}
          onMouseDown={() => {
            uploadMenuWasOpen.current = uploadMenu !== null;
          }}
          onClick={(event) => {
            if (uploadMenuWasOpen.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setUploadMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
          title={remoteTitle(t("filer.uploadFilesOrFolders"))}
          aria-label={t("filer.uploadFilesOrFolders")}
          aria-haspopup="menu"
          aria-expanded={uploadMenu !== null}
          disabled={!remote || busy || !path}
        >
          <Icon name="cloud-upload" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void downloadEntries(selectedEntries)}
          title={remoteTitle(t("filer.downloadFileOrFolder"))}
          aria-label={t("filer.downloadFileOrFolder")}
          disabled={!remote || selectedEntries.length === 0 || busy}
        >
          <Icon name="cloud-download" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void load(path)}
          title={t("filer.refresh")}
          aria-label={t("filer.refresh")}
          disabled={busy || offline}
        >
          <Icon name="refresh" />
        </button>
        <button
          className="panel-action filer-action filer-action-danger"
          onClick={() => setPendingDelete(selectedEntries)}
          title={t("common.delete")}
          aria-label={t("common.delete")}
          disabled={selectedEntries.length === 0 || busy || atDrivesRoot}
        >
          <Icon name="trash" />
        </button>
      </div>
      {uploadMenu && (
        <ContextMenu
          x={uploadMenu.x}
          y={uploadMenu.y}
          items={[
            {
              label: t("filer.uploadFiles"),
              icon: "cloud-upload",
              action: () => void upload(),
            },
            {
              label: t("filer.uploadFolder"),
              icon: "cloud-upload",
              action: () => void uploadFolder(),
            },
          ]}
          onClose={() => setUploadMenu(null)}
        />
      )}

      <div className="filer-path">
        <button
          className="panel-action filer-action"
          onClick={goUp}
          title={t("filer.parentFolder")}
          aria-label={t("filer.parentFolder")}
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => tab && void revealCwdInFiler(tab.info.id)}
          title={revealKey ? `${t("filer.terminalFolder")} (${revealKey})` : t("filer.terminalFolder")}
          aria-label={t("filer.terminalFolder")}
          disabled={busy || !canReveal}
        >
          <Icon name="target" />
        </button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(draft);
            if (event.key === "Escape") setDraft(path);
          }}
        />
      </div>

      <div className="filer-columns">
        <button
          type="button"
          className={`filer-col-name${sort.key === "name" ? " is-sorted" : ""}`}
          onClick={() => sortBy("name")}
          aria-label={t("filer.sortByName")}
        >
          {t("session.name")}
          <SortIndicator sort={sort} column="name" />
        </button>
        <button
          type="button"
          className={`filer-col-date${sort.key === "modified" ? " is-sorted" : ""}`}
          onClick={() => sortBy("modified")}
          aria-label={t("filer.sortByModified")}
        >
          {t("filer.modified")}
          <SortIndicator sort={sort} column="modified" />
        </button>
      </div>

      <div
        className="panel-body filer-list"
        role="listbox"
        aria-multiselectable="true"
        tabIndex={0}
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest(".filer-entry, .filer-new-entry")) {
            clearSelection();
          }
        }}
        onKeyDown={(event) => {
          if (busy) return;
          if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
          if ((IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault(); event.stopPropagation(); selection.selectAll();
          } else if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); clearSelection();
          }
        }}
        onContextMenu={(event) => openMenu(event, folderMenu())}
        aria-label={
          remote
            ? t("filer.remoteListAria", {
                proto: tab?.info.protocol.toUpperCase() ?? "",
              })
            : t("filer.localListAria")
        }
      >
        {offlineReason && !error && (
          <div className="panel-empty">{offlineReason}</div>
        )}
        {error && <div className="panel-empty">{error}</div>}
        {creating !== null && (
          <div className="row filer-new-entry">
            <FilerEntryIcon
              name={creating.name}
              isDir={creating.kind === "folder"}
              theme={theme}
            />
            <input
              autoFocus
              value={creating.name}
              placeholder={
                creating.kind === "folder"
                  ? t("filer.newFolderName")
                  : t("filer.newFileName")
              }
              onChange={(event) =>
                setCreating({ ...creating, name: event.target.value })
              }
              onBlur={commitNewEntry}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitNewEntry();
                if (event.key === "Escape") setCreating(null);
              }}
            />
          </div>
        )}
        <VirtualFileRows
          entries={sortedEntries}
          rowHeight={Math.max(24, panelFontSize + 10) + 2}
          resetKey={`${remoteId ?? "local"}:${path}:${sort.key}:${sort.direction}:${!!sort.explicit}`}
        >
          {(entry) => (
            <FilerRow
              key={entry.path}
              entry={entry}
              selected={selected.has(entry.path)}
              draggingOut={dragOut?.path === entry.path}
              theme={theme}
              onSelect={rowSelect}
              onActivate={rowActivate}
              onPointerDown={rowPointerDown}
              onPointerMove={rowPointerMove}
              onContextMenu={rowContextMenu}
            />
          )}
        </VirtualFileRows>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
      {pendingDelete && (
        <DeleteEntryDialog
          entry={pendingDelete[0]}
          entries={pendingDelete}
          location={remote ? (tab ? tabTitle(tab) : t("filer.remote")) : t("filer.local")}
          onConfirm={() => void removeEntries(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div className={`filer-footer${transfer ? " has-transfer" : ""}`}>
        {transfer ? (
          <div
            className={`filer-transfer is-${transfer.status}`}
            role="progressbar"
            aria-label={`${transferLabel}: ${transfer.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transferPercent ?? undefined}
            aria-valuetext={
              transfer.total > 0
                ? t("filer.ofAt", {
                    transferred: formatBytes(transfer.transferred),
                    total: formatBytes(transfer.total),
                    rate: formatBytes(transfer.bytesPerSecond),
                  })
                : t("filer.atRate", {
                    transferred: formatBytes(transfer.transferred),
                    rate: formatBytes(transfer.bytesPerSecond),
                  })
            }
          >
            <div className="filer-transfer-label">
              <span className="filer-transfer-name" title={transfer.name}>
                {transferLabel}: {transfer.name}
              </span>
              <span className="filer-transfer-value">
                {transfer.status === "error"
                  ? t("filer.failed")
                  : transfer.status === "cancelled"
                    ? t("filer.cancelled")
                    : transferPercent === null
                      ? formatBytes(transfer.transferred)
                      : `${transferPercent}%`}
              </span>
              {transfer.status === "running" && transfer.cancellable && (
                <button type="button" className="panel-action filer-action"
                  disabled={!backgroundTransfer || !["queued", "running", "retrying", "paused"].includes(backgroundTransfer.status)}
                  onClick={() => {
                    const id = activeTransfer.current?.id;
                    if (id) void api.controlFileTransfer(id, backgroundTransfer?.status === "paused" ? "resume" : "pause").catch((e) => setError(String(e)));
                  }}
                  title={backgroundTransfer?.status === "paused" ? t("filer.resume") : t("filer.pause")}
                  aria-label={backgroundTransfer?.status === "paused" ? t("filer.resumeTransfer") : t("filer.pauseTransfer")}>
                  <Icon name={backgroundTransfer?.status === "paused" ? "play" : "debug-pause"} />
                </button>
              )}
              {transfer.status === "running" && transfer.cancellable && (
                <button
                  className="panel-action filer-action filer-transfer-cancel"
                  onClick={cancelTransfer}
                  title={t("common.cancel")}
                  aria-label={t("filer.cancelName", { name: transfer.name })}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            <div
              className={`filer-transfer-track${transferPercent === null && transfer.status === "running" ? " is-indeterminate" : ""}`}
            >
              <span
                className="filer-transfer-bar"
                style={
                  transferPercent === null
                    ? undefined
                    : { width: `${transferPercent}%` }
                }
              />
            </div>
            <div className="filer-transfer-meta">
              <span>
                {formatBytes(transfer.transferred)}
                {transfer.total > 0 && ` / ${formatBytes(transfer.total)}`}
              </span>
              <span title={t("filer.transferSpeed")}>
                {formatBytes(transfer.bytesPerSecond)}/s
              </span>
            </div>
          </div>
        ) : dragOver?.accept ? (
          <span className="filer-drop-message">
            {remote ? t("filer.dropUpload") : t("filer.dropCopy")}
          </span>
        ) : dragOver?.reason ? (
          <span className="filer-drop-blocked">{dragOver.reason}</span>
        ) : (
          <>
            <span>{entrySummary}</span>
            {selectedEntries.length > 0 && <span>{t("filer.selectedCount", { count: selectedEntries.length })}</span>}
            {busy && <span>{t("filer.working")}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** Footer wording per transfer kind and state; see `TransferState`. */
const transferLabels = (
  t: Translate,
): Record<TransferState["kind"], Record<TransferState["status"], string>> => ({
  upload: {
    running: t("filer.tr.upload.running"),
    complete: t("filer.tr.upload.complete"),
    error: t("filer.tr.upload.error"),
    cancelled: t("filer.tr.upload.cancelled"),
  },
  download: {
    running: t("filer.tr.download.running"),
    complete: t("filer.tr.download.complete"),
    error: t("filer.tr.download.error"),
    cancelled: t("filer.tr.download.cancelled"),
  },
  sync: {
    running: t("filer.tr.sync.running"),
    complete: t("filer.tr.sync.complete"),
    error: t("filer.tr.sync.error"),
    cancelled: t("filer.tr.sync.cancelled"),
  },
  copy: {
    running: t("filer.tr.copy.running"),
    complete: t("filer.tr.copy.complete"),
    error: t("filer.tr.copy.error"),
    cancelled: t("filer.tr.copy.cancelled"),
  },
  stage: {
    running: t("filer.tr.stage.running"),
    complete: t("filer.tr.stage.complete"),
    error: t("filer.tr.stage.error"),
    cancelled: t("filer.tr.stage.cancelled"),
  },
});

type FilerEntryKind = "directory" | "file" | "symlink";

/** An entry being named inline at the top of the list before it exists. */
type NewEntryDraft = { kind: "file" | "folder"; name: string };

/**
 * One file row, memoised so a panel re-render that nothing on the row
 * depends on — a transfer footer tick, a drag-over verdict, another row
 * being selected — skips every row instead of rebuilding their JSX, titles
 * and dates. Only primitive/stable props cross this boundary; the callbacks
 * come from useStableCallback in the panel.
 */
const FilerRow = memo(function FilerRow({
  entry,
  selected,
  draggingOut,
  theme,
  onSelect,
  onActivate,
  onPointerDown,
  onPointerMove,
  onContextMenu,
}: {
  entry: FileEntry;
  selected: boolean;
  draggingOut: boolean;
  theme: ThemeMode;
  onSelect: (path: string, event: MouseEvent) => void;
  onActivate: (entry: FileEntry) => void;
  onPointerDown: (
    entry: FileEntry,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent, entry: FileEntry) => void;
}) {
  const kind = entryKind(entry);
  return (
    <div
      className={`row filer-entry is-${kind}${selected ? " is-active" : ""}${draggingOut ? " is-dragging-out" : ""}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => onSelect(entry.path, event)}
      onPointerDown={(event) => onPointerDown(entry, event)}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onActivate(entry)}
      onContextMenu={(event) => onContextMenu(event, entry)}
      title={entryTitle(entry)}
    >
      <FilerEntryIcon
        name={entry.name}
        isDir={entry.isDir}
        theme={theme}
      />
      <span className="row-label">{entry.name}</span>
      <span className="filer-col-date row-meta">
        {formatDate(entry.modified)}
      </span>
    </div>
  );
});

const FilerEntryIcon = memo(function FilerEntryIcon({
  name,
  isDir,
  theme,
}: {
  name: string;
  isDir: boolean;
  theme: ThemeMode;
}) {
  return (
    <span className="filer-icon">
      <FileIcon name={name} isDir={isDir} theme={theme} />
    </span>
  );
});


/** Applications the user has opened files with, most recent first. */
const OPEN_WITH_KEY = FILER_OPEN_WITH_KEY;
const OPEN_WITH_LIMIT = 6;

function loadOpenWithApps(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(OPEN_WITH_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((app): app is string => typeof app === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberOpenWithApp(app: string): string[] {
  const apps = [app, ...loadOpenWithApps().filter((known) => known !== app)];
  const kept = apps.slice(0, OPEN_WITH_LIMIT);
  try {
    localStorage.setItem(OPEN_WITH_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or unavailable: the menu still works for this session.
  }
  return kept;
}

/** `/Applications/Visual Studio Code.app` → `Visual Studio Code`. */
function appDisplayName(app: string): string {
  const base = localFileName(app);
  return base.replace(/\.(app|exe)$/i, "");
}

function remoteParent(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

function joinRemote(base: string, name: string): string {
  if (base.endsWith("/")) return `${base}${name}`;
  return `${base}/${name}`;
}

function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "upload.bin";
}

function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function pickedPaths(picked: string | string[] | null): string[] {
  if (Array.isArray(picked)) return picked;
  return typeof picked === "string" ? [picked] : [];
}

function entryKind(entry: FileEntry): FilerEntryKind {
  if (entry.isSymlink) return "symlink";
  return entry.isDir ? "directory" : "file";
}

function entryKindLabel(kind: FilerEntryKind): string {
  if (kind === "directory") return translateMsg("filer.kindFolder");
  if (kind === "symlink") return translateMsg("filer.kindLink");
  return translateMsg("filer.kindFile");
}

function entryTitle(entry: FileEntry): string {
  const kind = entryKind(entry);
  const attributes = [entryKindLabel(kind)];
  if (!entry.isDir) attributes.push(formatBytes(entry.size));
  if (entry.permissions !== null) {
    attributes.push(
      translateMsg("filer.mode", {
        mode: (entry.permissions & 0o7777).toString(8).padStart(4, "0"),
      }),
    );
  }
  if (entry.owner) {
    attributes.push(entry.group ? `${entry.owner}:${entry.group}` : entry.owner);
  }
  return `${entry.path}\n${attributes.join(" · ")}`;
}

function formatEntrySummary(entries: FileEntry[]): string {
  let folders = 0;
  let files = 0;
  let links = 0;
  for (const entry of entries) {
    const kind = entryKind(entry);
    if (kind === "directory") folders += 1;
    else if (kind === "symlink") links += 1;
    else files += 1;
  }

  const parts = [
    folders > 0
      ? translateMsg(
          folders === 1 ? "filer.oneFolder" : "filer.manyFolders",
          { count: folders },
        )
      : "",
    files > 0
      ? translateMsg(files === 1 ? "filer.oneFile" : "filer.manyFiles", {
          count: files,
        })
      : "",
    links > 0
      ? translateMsg(links === 1 ? "filer.oneLink" : "filer.manyLinks", {
          count: links,
        })
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : translateMsg("filer.zeroItems");
}

function formatDate(seconds: number | null): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

// The Filer takes no props: memoising it keeps the app's re-renders (a tab
// switch, a status change) from re-walking a large directory's rows.
export const FilerPanel = memo(FilerPanelBase);
