import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import * as api from "../../api";
import { errorText, isCancelled } from "../../errorInfo";
import { useFileTransfers } from "../../fileTransfers";
import { useStore } from "../../store";
import type { Translate } from "../../i18n";
import { ask, open as openDialog } from "../../nativeDialog";
import type { FileEntry } from "../../types";
import { joinRemote, localFileName, pickedPaths } from "./filerPresentation";
import type { TransferState } from "./filerTypes";

interface Options {
  remoteId: string | null;
  path: string;
  /** The listing on screen, to warn before an upload replaces an entry. */
  entries: readonly FileEntry[];
  busyRef: RefObject<boolean>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  beginTransfer: (
    kind: TransferState["kind"],
    name: string,
    cancellable?: boolean,
    retry?: () => void,
  ) => string | undefined;
  finishTransfer: (status: "complete" | "error" | "cancelled", id?: string | undefined) => void;
  load: (target: string, quiet?: boolean, resume?: boolean) => Promise<boolean>;
  failTransfer: (e: unknown, id?: string | undefined) => void;
  refresh: (sessionId: string, target: string) => Promise<void>;
  remoteIdRef: RefObject<string | null>;
  offlineReasonRef: RefObject<string | null>;
  updateTransferProgress: (progress: api.TransferProgress) => void;
  t: Translate;
}

export function useFilerUpload({
  remoteId,
  path,
  entries,
  busyRef,
  setBusy,
  setError,
  beginTransfer,
  finishTransfer,
  load,
  failTransfer,
  refresh,
  remoteIdRef,
  offlineReasonRef,
  updateTransferProgress,
  t,
}: Options) {
  const [choosingUpload, setChoosingUpload] = useState(false);
  const choosing = useRef(false);
  const alive = useRef(false);
  const context = useRef({ remoteId, path });
  if (context.current.remoteId !== remoteId || context.current.path !== path) {
    context.current = { remoteId, path };
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A picker/confirmation belongs to the destination visible when it opened.
  // Switching sessions or folders invalidates it, including a switch away and back.
  const chooseUpload = async (pick: () => Promise<string[]>) => {
    if (!remoteId || !path || busyRef.current || choosing.current) return;
    const target = context.current;
    const current = () => alive.current && context.current === target;
    choosing.current = true;
    setChoosingUpload(true);
    try {
      const localPaths = await pick();
      if (!current() || localPaths.length === 0) return;
      const sessionId = remoteId;
      const destination = path;
      // The backend replaces a same-named file in place. Ask once for the whole
      // batch, the way a file manager does, instead of letting a drag overwrite
      // silently.
      const clashes = localPaths.filter((localPath) =>
        entries.some((entry) => entry.name === localFileName(localPath)),
      );
      if (clashes.length > 0) {
        const confirmed = await ask(t("filer.replaceConfirm", { count: clashes.length }), {
          title: t("filer.replaceTitle"),
          kind: "warning",
          okLabel: t("filer.replace"),
          cancelLabel: t("common.cancel"),
        });
        if (!confirmed || !current()) return;
      }
      setError(null);
      const name =
        localPaths.length === 1
          ? localFileName(localPaths[0])
          : t("filer.manyItems", { count: localPaths.length });
      const transfer = api.newTransferId();
      const items: api.TransferItem[] = localPaths.map((localPath) => ({
        local: localPath,
        remote: joinRemote(destination, localFileName(localPath)),
        upload: true,
      }));
      // Queue snapshots own progress, cancellation and retry, also after unmount.
      void api
        .transferFiles(sessionId, items, () => {}, transfer)
        .catch((error) => {
          const status = useFileTransfers.getState().jobs[transfer]?.status;
          if (status === "cancelled" || status === "cancelling" || isCancelled(error)) return;
          useStore
            .getState()
            .setError(t("filer.uploadFailed", { name, error: errorText(error) }), sessionId);
        })
        .finally(() => {
          if (alive.current) void refresh(sessionId, destination);
        });
    } catch (e) {
      if (current()) setError(errorText(e));
    } finally {
      choosing.current = false;
      if (alive.current) setChoosingUpload(false);
    }
  };

  const uploadPaths = (localPaths: string[]) => chooseUpload(async () => localPaths);

  /**
   * The local copy itself, against an explicit destination, so the footer's
   * retry after a failure lands where the drop was made.
   */
  const runCopy = async (sources: string[], destination: string) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let skipped = 0;
    const retry = () => void runCopy(sources, destination);
    try {
      for (const source of sources) {
        beginTransfer("copy", localFileName(source), false, retry);
        const summary = await api.localCopyInto(source, destination, updateTransferProgress);
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
      // Reload first: it clears the error line, and what did arrive should
      // show; the local copy's failure then keeps the footer's retry.
      await load(destination);
      failTransfer(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
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
    await runCopy(sources, path);
  };

  const upload = () => chooseUpload(async () => pickedPaths(await openDialog({ multiple: true })));
  const uploadFolder = () =>
    chooseUpload(async () => pickedPaths(await openDialog({ directory: true, multiple: true })));

  return { upload, uploadFolder, uploadPaths, copyPaths, choosingUpload };
}
