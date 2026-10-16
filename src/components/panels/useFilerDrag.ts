import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as api from "../../api";
import type { Translate } from "../../i18n";
import { IS_MAC } from "../../platform";
import type { FileEntry } from "../../types";
import { useStableCallback } from "../../useStableCallback";
import { DRAG_OUT_THRESHOLD, dropPoint } from "./filerPresentation";
import type { ActiveTransfer, TransferState } from "./filerTypes";
import { DragOutState, DragPress, DropVerdict } from "./filerTypes";

interface Options {
  remoteId: string | null;
  uploadPaths: (localPaths: string[]) => Promise<void>;
  copyPaths: (sources: string[]) => Promise<void>;
  offlineReasonRef: RefObject<string | null>;
  pathRef: RefObject<string>;
  t: Translate;
  remoteIdRef: RefObject<string | null>;
  busyRef: RefObject<boolean>;
  setError: Dispatch<SetStateAction<string | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  beginTransfer: (
    kind: TransferState["kind"],
    name: string,
    cancellable?: boolean,
  ) => string | undefined;
  progressFor: (id: string | undefined) => (progress: api.TransferProgress) => void;
  finishTransfer: (status: "complete" | "error" | "cancelled", id?: string | undefined) => void;
  activeTransfer: RefObject<ActiveTransfer | null>;
  failTransfer: (e: unknown, id?: string | undefined) => void;
  ownsTransfer: (id: string | undefined) => boolean;
  atDrivesRoot: boolean;
  selected: ReadonlySet<string>;
  selectedEntries: FileEntry[];
  collapseSelection: RefObject<string | null>;
  selectEntry: (
    path: string,
    args_1?: { toggle?: boolean | undefined; range?: boolean | undefined } | undefined,
  ) => void;
  cancelTransfer: () => void;
  busy: boolean;
}

export function useFilerDrag({
  remoteId,
  uploadPaths,
  copyPaths,
  offlineReasonRef,
  pathRef,
  t,
  remoteIdRef,
  busyRef,
  setError,
  setBusy,
  beginTransfer,
  progressFor,
  finishTransfer,
  activeTransfer,
  failTransfer,
  ownsTransfer,
  atDrivesRoot,
  selected,
  selectedEntries,
  collapseSelection,
  selectEntry,
  cancelTransfer,
  busy,
}: Options) {
  const [dragOver, setDragOver] = useState<DropVerdict | null>(null);
  const [dragOut, setDragOut] = useState<DragOutState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
          setError(t("filer.couldNotDrag", { name: entry.name, error: outcome.error }));
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
            void deliverPromised(sessionId, entry, event.token, event.destination);
            break;
          case "ended":
            updateDragOut(null);
            break;
          case "failed":
            updateDragOut(null);
            setError(t("filer.couldNotDrag", { name: entry.name, error: event.error }));
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
        await api.sftpDownload(sessionId, entry.path, destination, progressFor(transfer), transfer);
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
      await handToSystem(
        entry,
        chosen.map((item) => item.path),
      );
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
    const transfer = beginTransfer(
      "stage",
      chosen.length === 1 ? entry.name : t("filer.selectedCount", { count: chosen.length }),
      true,
    );
    try {
      const staged = await Promise.all(
        chosen.map(async (item) => ({
          local: await api.dragStagingPath(item.name),
          remote: item.path,
          upload: false,
          directory: item.isDir,
        })),
      );
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
        await handToSystem(
          entry,
          staged.map((item) => item.local),
        );
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

  const onEntryPointerDown = (entry: FileEntry, event: ReactPointerEvent<HTMLDivElement>) => {
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
  const release = useStableCallback((event: Event) => {
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
  });
  useEffect(() => {
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
  }, [release]);

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
        const ours = payload.paths.every((dropped) => handedOutPaths.current.includes(dropped));
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
  }, [setError]);

  useEffect(() => {
    if (busy) setDragOver(null);
  }, [busy]);

  return { onEntryPointerDown, onEntryPointerMove, panelRef, dragOver, dragOut };
}
