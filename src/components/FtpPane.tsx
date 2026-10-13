import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import * as api from "../api";
import { createDragAutoScroll } from "../edgeScroll";
import { useFileTransfers } from "../fileTransfers";
import {
  sortFileEntries,
  toggleFileSort,
  type SortKey,
} from "../fileSort";
import {
  dropAction,
  type DraggedEntry,
  type DropTarget,
  type PaneSide,
} from "../paneDrop";
import { createFrameGate } from "../frameGate";
import { SortIndicator } from "./SortIndicator";
import { useStore, type Tab } from "../store";
import type { FileEntry, ThemeMode } from "../types";
import { useStableCallback } from "../useStableCallback";
import { FileIcon } from "./FileIcon";
import { Icon } from "./icons";
import { VirtualFileRows } from "./VirtualFileRows";

/** Pointer travel before a press on a row turns into a drag. */
const DRAG_THRESHOLD = 5;

interface Props {
  tab: Tab;
  active: boolean;
}

interface TransferState {
  direction: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  status: "running" | "complete" | "error" | "cancelled";
  message?: string;
}

interface FileBrowserProps {
  title: string;
  subtitle: string;
  path: string;
  draft: string;
  entries: FileEntry[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  actions?: ReactNode;
  side: PaneSide;
  /** The scrolling row list, for the drag's edge auto-scroll; see FtpPane. */
  listRef?: RefObject<HTMLDivElement | null>;
  /** The pointer-drag wiring; see FtpPane's `beginPress` / `dragMove`. */
  onItemPointerDown: (
    side: PaneSide,
    entry: FileEntry,
    event: ReactPointerEvent,
  ) => void;
  onItemPointerMove: (event: ReactPointerEvent) => void;
  onItemPointerUp: (event: ReactPointerEvent) => void;
  onDragCancel: () => void;
  /** The row being dragged, so rows can dim it; null when there is none. */
  draggingPath: string | null;
  /** The folder or pane under the pointer, for highlighting. */
  dropHover: { side: PaneSide; dir: string } | null;
  onDraftChange: (value: string) => void;
  onOpenPath: (path: string) => void;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onSelect: (path: string) => void;
  onActivate: (entry: FileEntry) => void;
}

export function FtpPane({ tab, active }: Props) {
  const sessionId = tab.info.id;
  // The pane serves both FTP and SFTP file sessions; only the labels differ.
  const protocolLabel = tab.info.kind === "sftp" ? "SFTP" : "FTP";

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

  const [transferring, setTransferring] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const transferId = useRef<string | null>(null);
  const transferJob = useFileTransfers((s) => s.jobs[transferId.current ?? ""]);
  // The entry a pointer drag is carrying, plus the press that may become
  // one. Refs are what the gesture handlers read; the states re-render the
  // rows so the dragged one can dim and the target can highlight.
  const draggedRef = useRef<DraggedEntry | null>(null);
  const [dragging, setDragging] = useState<DraggedEntry | null>(null);
  const dragPressRef = useRef<{
    side: PaneSide;
    entry: FileEntry;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState<{
    side: PaneSide;
    dir: string;
  } | null>(null);

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
      setLocalError(String(error));
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

  const updateProgress = (progress: api.TransferProgress) => {
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred: progress.transferred,
            total: progress.total,
          }
        : current,
    );
  };

  /**
   * The entries a landing folder holds, for the conflict checks. The pane in
   * view already has them in hand; a folder row's are fetched.
   */
  const entriesAt = async (
    side: PaneSide,
    dir: string,
  ): Promise<FileEntry[]> => {
    if (side === "remote") {
      if (dir === remotePath) return remoteEntries;
      return (await api.sftpList(sessionId, dir)).entries;
    }
    if (dir === localPath) return localEntries;
    return (await api.localList(dir)).entries;
  };

  /**
   * The gate every landing shares: same-name checks with the target pane's
   * wording. False means stop — an error was shown or the user declined.
   */
  const mayLand = (
    side: PaneSide,
    incoming: FileEntry,
    existing: FileEntry | undefined,
  ): boolean => {
    const setError = side === "remote" ? setRemoteError : setLocalError;
    if (!existing) return true;
    if (side === "local" && existing.isSymlink) {
      setError(`Refusing to replace local symlink “${incoming.name}”.`);
      return false;
    }
    if (existing.isDir !== incoming.isDir) {
      setError(
        incoming.isDir
          ? `A ${side} file named “${incoming.name}” already exists.`
          : `A ${side} folder named “${incoming.name}” already exists.`,
      );
      return false;
    }
    const prompt = incoming.isDir
      ? `Merge into ${side} folder “${incoming.name}”? Existing files with the same names will be replaced.`
      : `Replace ${side} file “${incoming.name}”?`;
    return window.confirm(prompt);
  };

  const runUpload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("remote", destDir)).find(
        (entry) => entry.name === incoming.name,
      );
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
      return;
    }
    if (!mayLand("remote", incoming, existing)) return;

    setRemoteError(null);
    setTransferring(true);
    transferId.current = api.newTransferId();
    setTransfer({
      direction: "upload",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinRemote(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpUploadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      } else {
        await api.sftpUpload(sessionId, incoming.path, destination, updateProgress, transferId.current);
      }
      setTransfer((current) =>
        current ? { ...current, status: "complete" } : current,
      );
      await loadRemote(remotePath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? { ...current, status: String(error).includes("transfer cancelled") ? "cancelled" : "error", message: String(error) }
          : current,
      );
    } finally {
      transferId.current = null;
      setTransferring(false);
    }
  };

  const runDownload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("local", destDir)).find(
        (entry) => entry.name === incoming.name,
      );
    } catch (error) {
      setLocalError(String(error));
      return;
    }
    if (!mayLand("local", incoming, existing)) return;

    setLocalError(null);
    setTransferring(true);
    transferId.current = api.newTransferId();
    setTransfer({
      direction: "download",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinLocal(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
          transferId.current,
        );
      } else {
        await api.sftpDownload(sessionId, incoming.path, destination, updateProgress, transferId.current);
      }
      setTransfer((current) =>
        current ? { ...current, status: "complete" } : current,
      );
      await loadLocal(localPath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? { ...current, status: String(error).includes("transfer cancelled") ? "cancelled" : "error", message: String(error) }
          : current,
      );
    } finally {
      transferId.current = null;
      setTransferring(false);
    }
  };

  const upload = () => {
    if (selectedLocal) void runUpload(selectedLocal, remotePath);
  };

  const download = () => {
    if (selectedRemote) void runDownload(selectedRemote, localPath);
  };

  /**
   * Reads the drop target under a point from the panes' data attributes: a
   * folder row names its own folder, the list behind it names the pane's
   * directory, and a file row has neither so the list still answers for it.
   */
  const targetAt = (x: number, y: number): DropTarget | null => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest("[data-drop-side]");
    const side = element?.getAttribute("data-drop-side");
    const dir = element?.getAttribute("data-drop-dir");
    if ((side !== "local" && side !== "remote") || !dir) return null;
    return { side, dir };
  };

  const beginPress = (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => {
    if (event.button !== 0 || transferring) return;
    dragPressRef.current = {
      side,
      entry,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    // Without the capture a quick flick leaves the row before the threshold
    // is reached and the drag never starts.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDragState = () => {
    // A scheduled hit test must not fire after the drag is over and light a
    // highlight nothing will clear.
    hoverGate.current?.cancel();
    dragScroll.current?.stop();
    dragPressRef.current = null;
    draggedRef.current = null;
    setDragging(null);
    setDropHover(null);
  };

  // A drag held at a list's top or bottom edge keeps that list scrolling
  // (see edgeScroll.ts); the pointer position arrives with each gated hover
  // pass, and the loop keeps itself alive only while it is near an edge.
  const remoteListRef = useRef<HTMLDivElement>(null);
  const localListRef = useRef<HTMLDivElement>(null);
  const dragScroll = useRef<ReturnType<typeof createDragAutoScroll> | null>(
    null,
  );
  if (dragScroll.current === null) {
    dragScroll.current = createDragAutoScroll(() =>
      [remoteListRef.current, localListRef.current].filter(
        (element): element is HTMLDivElement => element !== null,
      ),
      36,
      14,
      (x, y) => hoverGate.current?.schedule({ x, y }),
    );
  }

  // The drop-target hit test runs once per frame on the pointer's latest
  // position, not per pointermove: `elementFromPoint` forces a layout when
  // the DOM is dirty, and a fast pointer crosses dozens of positions a
  // frame. The release does its own hit test, so a collapsed one loses
  // nothing. See frameGate.ts.
  const hoverApply = useStableCallback((at: { x: number; y: number }) => {
    const target = targetAt(at.x, at.y);
    const source = draggedRef.current;
    const hover = source && target && dropAction(source, target) ? target : null;
    dragScroll.current?.update(at.x, at.y);
    setDropHover((current) =>
      current?.side === hover?.side && current?.dir === hover?.dir
        ? current
        : hover,
    );
  });
  const hoverGate = useRef<
    ReturnType<typeof createFrameGate<{ x: number; y: number }>> | null
  >(null);
  if (hoverGate.current === null) {
    hoverGate.current = createFrameGate(hoverApply);
  }

  const dragMove = (event: ReactPointerEvent) => {
    const press = dragPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!draggedRef.current) {
      if (
        Math.abs(event.clientX - press.x) < DRAG_THRESHOLD &&
        Math.abs(event.clientY - press.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      const source = { side: press.side, entry: press.entry };
      draggedRef.current = source;
      setDragging(source);
    }
    hoverGate.current!.schedule({ x: event.clientX, y: event.clientY });
  };

  /** The release: whatever sits under the pointer takes the drop. */
  const dragRelease = (event: ReactPointerEvent) => {
    const source = draggedRef.current;
    const target = source ? targetAt(event.clientX, event.clientY) : null;
    const action =
      source && target && !transferring ? dropAction(source, target) : null;
    endDragState();
    if (!source || !target || !action) return;
    if (action.kind === "upload") {
      void runUpload(source.entry, target.dir);
    } else {
      void runDownload(source.entry, target.dir);
    }
  };

  // Escape is the only way out of a drag that stays inside the window.
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDragState();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [dragging]);

  // File tabs stay mounted while hidden, so unmount cleanup alone is not
  // enough to stop an in-progress drag and its animation frames.
  useEffect(() => {
    if (!active) endDragState();
  }, [active]);

  // A drag torn down by unmount (the tab switched mid-drag) must not let a
  // gated hit test or the edge auto-scroll fire afterwards.
  useEffect(
    () => () => {
      hoverGate.current?.cancel();
      dragScroll.current?.stop();
    },
    [],
  );

  // The row-boundary callbacks are stable identities (see useStableCallback)
  // so the memoised rows skip re-rendering when this pane re-renders — a
  // transfer tick, a hover change, a selection in the other pane. The rows
  // pass their own `side`, so the handlers need no per-pane closures.
  const itemPointerDown = useStableCallback(
    (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) =>
      beginPress(side, entry, event),
  );
  const itemPointerMove = useStableCallback((event: ReactPointerEvent) =>
    dragMove(event),
  );
  const itemPointerUp = useStableCallback((event: ReactPointerEvent) =>
    dragRelease(event),
  );
  const dragCancel = useStableCallback(() => endDragState());
  const activateRemote = useStableCallback((entry: FileEntry) => {
    if (entry.isDir) void loadRemote(entry.path);
  });
  const activateLocal = useStableCallback((entry: FileEntry) => {
    if (entry.isDir) void loadLocal(entry.path);
  });

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
      await api.sftpRename(
        sessionId,
        selectedRemote.path,
        joinRemote(remotePath, name),
      );
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
      await api.sftpRemove(
        sessionId,
        selectedRemote.path,
        selectedRemote.isDir,
      );
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
      await api.localRename(
        selectedLocal.path,
        joinLocal(localPath, name),
      );
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
      await api.localRemove(
        selectedLocal.path,
        selectedLocal.isDir,
      );
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(100, (transfer.transferred / transfer.total) * 100)
        : null
    : null;

  return (
    <div className={`ftp-workspace${active ? "" : " is-hidden"}`}>
      {tab.state !== "connected" ? (
        <div className={`ftp-session-state is-${tab.state}`}>
          <strong>
            {tab.state === "connecting"
              ? `Connecting to ${protocolLabel}…`
              : `${protocolLabel} unavailable`}
          </strong>
          <span>{tab.message ?? tab.info.address}</span>
        </div>
      ) : (
        <>
          <div className={`ftp-dual-pane${dragging ? " is-dragging" : ""}`}>
            <FileBrowser
              title={`${protocolLabel} Server`}
              subtitle={tab.info.address}
              side="remote"
              listRef={remoteListRef}
              onItemPointerDown={itemPointerDown}
              onItemPointerMove={itemPointerMove}
              onItemPointerUp={itemPointerUp}
              onDragCancel={dragCancel}
              draggingPath={dragging?.entry.path ?? null}
              dropHover={dropHover}
              path={remotePath}
              draft={remoteDraft}
              entries={remoteEntries}
              selected={remoteSelected}
              loading={remoteLoading}
              error={remoteError}
              onDraftChange={setRemoteDraft}
              onOpenPath={(path) => void loadRemote(path)}
              onHome={() => void loadRemote(remoteHome)}
              onParent={() => void loadRemote(remoteParent(remotePath))}
              onRefresh={() => void loadRemote(remotePath || remoteHome)}
              onSelect={setRemoteSelected}
              onActivate={activateRemote}
              actions={
                <>
                  <ToolButton
                    label="New remote folder"
                    onClick={() => void createRemoteFolder()}
                    disabled={remoteLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename remote item"
                    onClick={() => void renameRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete remote item"
                    onClick={() => void removeRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
                  </ToolButton>
                </>
              }
            />

            <div className="ftp-transfer-rail" aria-label="File transfer actions">
              <button
                className="ftp-transfer-button"
                onClick={() => void upload()}
                disabled={!selectedLocal || transferring}
                title="Upload selected local file or folder"
              >
                <span>←</span>
                Upload
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void download()}
                disabled={!selectedRemote || transferring}
                title={`Download selected ${protocolLabel} file or folder`}
              >
                Download
                <span>→</span>
              </button>
            </div>

            <FileBrowser
              title="Local Computer"
              subtitle="This device"
              side="local"
              listRef={localListRef}
              onItemPointerDown={itemPointerDown}
              onItemPointerMove={itemPointerMove}
              onItemPointerUp={itemPointerUp}
              onDragCancel={dragCancel}
              draggingPath={dragging?.entry.path ?? null}
              dropHover={dropHover}
              path={localPath}
              draft={localDraft}
              entries={localEntries}
              selected={localSelected}
              loading={localLoading}
              error={localError}
              onDraftChange={setLocalDraft}
              onOpenPath={(path) => void loadLocal(path)}
              onHome={() => void loadLocal(localHome)}
              onParent={() => {
                void api.localParent(localPath).then(loadLocal);
              }}
              onRefresh={() => void loadLocal(localPath || localHome)}
              onSelect={setLocalSelected}
              onActivate={activateLocal}
              actions={
                <>
                  <ToolButton
                    label="New local folder"
                    onClick={() => void createLocalFolder()}
                    disabled={localLoading || transferring}
                  >
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename local item"
                    onClick={() => void renameLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete local item"
                    onClick={() => void removeLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
                  </ToolButton>
                </>
              }
            />
          </div>

          <div className={`ftp-transfer-status${transfer ? " has-transfer" : ""}`}>
            {transfer ? (
              <>
                <div className="ftp-transfer-summary">
                  <span>
                    {transfer.status === "complete"
                      ? "Complete"
                      : transfer.status === "error"
                        ? "Failed"
                        : transfer.status === "cancelled"
                          ? "Cancelled"
                        : transfer.direction === "upload"
                          ? "Uploading"
                          : "Downloading"}
                    : {transfer.name}
                  </span>
                  <span>
                    {formatBytes(transfer.transferred)}
                    {transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ""}
                  </span>
                </div>
                <div className="ftp-transfer-progress">
                  <span
                    className={transferPercent === null ? "is-indeterminate" : ""}
                    style={
                      transferPercent === null
                        ? undefined
                        : { width: `${transferPercent}%` }
                    }
                  />
                </div>
                {transfer.message && (
                  <div className="ftp-transfer-error">{transfer.message}</div>
                )}
                {transferring && transferId.current && <div className="transfer-job-actions">
                  <span>{transferJob?.status === "paused" ? "Paused" : transferJob?.phase}</span>
                  <button type="button" disabled={!transferJob || !["queued", "running", "retrying", "paused"].includes(transferJob.status)}
                    onClick={() => void api.controlFileTransfer(transferId.current!, transferJob?.status === "paused" ? "resume" : "pause").catch((e) => setRemoteError(String(e)))}>
                    {transferJob?.status === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button type="button" onClick={() => void api.cancelTransfer(transferId.current!).catch((e) => setRemoteError(String(e)))}>Cancel</button>
                </div>}
              </>
            ) : (
              <span>{`Select a local file or folder to upload, or a ${protocolLabel} file or folder to download.`}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function FileBrowser({
  title,
  subtitle,
  path,
  draft,
  entries,
  selected,
  loading,
  error,
  actions,
  side,
  listRef,
  onItemPointerDown,
  onItemPointerMove,
  onItemPointerUp,
  onDragCancel,
  draggingPath,
  dropHover,
  onDraftChange,
  onOpenPath,
  onHome,
  onParent,
  onRefresh,
  onSelect,
  onActivate,
}: FileBrowserProps) {
  const theme = useStore((s) => s.theme);
  // One shared choice for both browsers and the Filer panel (see the store's
  // `filerSort`); reading the stored preference once per mount let the two
  // panes drift apart after a change on either side.
  const sort = useStore((s) => s.filerSort);
  const setFilerSort = useStore((s) => s.setFilerSort);
  const sortedEntries = useMemo(
    () => sortFileEntries(entries, sort),
    [entries, sort],
  );

  /** Re-sorts the list for a clicked column caption and remembers the choice. */
  const sortBy = (key: SortKey) => {
    setFilerSort(toggleFileSort(useStore.getState().filerSort, key));
  };

  return (
    <section className="ftp-file-browser">
      <div className="ftp-browser-header">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="ftp-browser-actions">
          <ToolButton label="Home" onClick={onHome} disabled={loading}>
            <Icon name="home" />
          </ToolButton>
          <ToolButton label="Parent folder" onClick={onParent} disabled={loading || !path}>
            <Icon name="arrow-up" />
          </ToolButton>
          <ToolButton label="Refresh" onClick={onRefresh} disabled={loading}>
            <Icon name="refresh" />
          </ToolButton>
          {actions}
        </div>
      </div>

      <div className="ftp-browser-path">
        <input
          value={draft}
          aria-label={`${title} path`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpenPath(draft);
            if (event.key === "Escape") onDraftChange(path);
          }}
        />
      </div>

      <div className="ftp-browser-columns">
        <button
          type="button"
          className={sort.key === "name" ? "is-sorted" : undefined}
          onClick={() => sortBy("name")}
          aria-label="Sort by name"
        >
          Name<SortIndicator sort={sort} column="name" />
        </button>
        <button
          type="button"
          className={sort.key === "size" ? "is-sorted" : undefined}
          onClick={() => sortBy("size")}
          aria-label="Sort by size"
        >
          Size<SortIndicator sort={sort} column="size" />
        </button>
        <button
          type="button"
          className={sort.key === "modified" ? "is-sorted" : undefined}
          onClick={() => sortBy("modified")}
          aria-label="Sort by last modified"
        >
          Modified<SortIndicator sort={sort} column="modified" />
        </button>
      </div>

      <div
        ref={listRef}
        className={`ftp-browser-list${dropHover != null && dropHover.side === side && dropHover.dir === path ? " is-drop-target" : ""}`}
        data-drop-side={side}
        data-drop-dir={path}
        role="listbox"
        aria-label={`${title} files`}
      >
        {error && <div className="ftp-browser-message is-error">{error}</div>}
        {!error && loading && <div className="ftp-browser-message">Loading…</div>}
        {!error && !loading && entries.length === 0 && (
          <div className="ftp-browser-message">This folder is empty.</div>
        )}
        {!error && (
          <VirtualFileRows
            entries={sortedEntries}
            rowHeight={29}
            resetKey={`${side}:${path}:${sort.key}:${sort.direction}:${!!sort.explicit}`}
          >
            {(entry, index) => (
              <FtpFileRow
                key={entry.path}
                entry={entry}
                position={index + 1}
                total={sortedEntries.length}
                side={side}
                selected={selected === entry.path}
                dragSource={draggingPath === entry.path}
                dropTarget={
                  dropHover != null &&
                  dropHover.side === side &&
                  dropHover.dir === entry.path
                }
                theme={theme}
                onSelect={onSelect}
                onActivate={onActivate}
                onPointerDown={onItemPointerDown}
                onPointerMove={onItemPointerMove}
                onPointerUp={onItemPointerUp}
                onDragCancel={onDragCancel}
              />
            )}
          </VirtualFileRows>
        )}
      </div>
      <div className="ftp-browser-footer">
        <span>{entries.length} items</span>
        <span>{loading ? "Loading…" : path}</span>
      </div>
    </section>
  );
}

/**
 * One row of a browser pane, memoised so a re-render that nothing on the row
 * depends on — a transfer tick, a hover elsewhere, a selection in the other
 * pane — skips every row instead of rebuilding its JSX, size and date
 * strings. Only primitive props and stable callbacks cross this boundary
 * (see useStableCallback); the drag/drop flags arrive as booleans so a
 * hover change re-renders at most the one row it moved to.
 */
const FtpFileRow = memo(function FtpFileRow({
  entry,
  position,
  total,
  side,
  selected,
  dragSource,
  dropTarget,
  theme,
  onSelect,
  onActivate,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDragCancel,
}: {
  entry: FileEntry;
  position: number;
  total: number;
  side: PaneSide;
  selected: boolean;
  dragSource: boolean;
  dropTarget: boolean;
  theme: ThemeMode;
  onSelect: (path: string) => void;
  onActivate: (entry: FileEntry) => void;
  onPointerDown: (
    side: PaneSide,
    entry: FileEntry,
    event: ReactPointerEvent,
  ) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onDragCancel: () => void;
}) {
  return (
    <div
      className={`ftp-file-row${selected ? " is-selected" : ""}${entry.isDir ? " is-directory" : ""}${dragSource ? " is-drag-source" : ""}${dropTarget ? " is-drop-target" : ""}`}
      role="option"
      aria-posinset={position}
      aria-setsize={total}
      aria-selected={selected}
      data-drop-side={entry.isDir ? side : undefined}
      data-drop-dir={entry.isDir ? entry.path : undefined}
      onPointerDown={(event) => onPointerDown(side, entry, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onDragCancel}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => onActivate(entry)}
      title={entry.path}
    >
      <span className="ftp-file-name">
        <span className="ftp-file-icon" aria-hidden="true">
          <FileIcon name={entry.name} isDir={entry.isDir} theme={theme} />
        </span>
        <span>{entry.name}</span>
      </span>
      <span>{entry.isDir ? "—" : formatBytes(entry.size)}</span>
      <span>{formatDate(entry.modified)}</span>
    </div>
  );
});

function ToolButton({
  label,
  children,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`ftp-tool-button${danger ? " is-danger" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function remoteParent(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

function joinRemote(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;
}

function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? "0 B" : "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

// One formatter for every row's date: `toLocaleString` with options builds
// an Intl.DateTimeFormat per call, and a thousand-row list re-renders its
// dates often enough for that to show. `toLocaleString` is specified as
// exactly this constructor plus `format`, so the output is identical.
const ROW_DATE = new Intl.DateTimeFormat([], {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(seconds: number | null): string {
  if (seconds == null) return "—";
  return ROW_DATE.format(new Date(seconds * 1000));
}

function friendlyFtpError(error: unknown): string {
  const message = String(error);
  if (message.includes("Response contains an invalid syntax")) {
    return "The FTP server returned a legacy or non-UTF-8 directory listing. Reconnect after updating EdgeTerm and try again.";
  }
  return message;
}
