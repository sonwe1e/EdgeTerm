import type { Dispatch, RefObject, SetStateAction } from "react";
import { errorText } from "../../errorInfo";
import * as api from "../../api";
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
  ) => string | undefined;
  progressFor: (id: string | undefined) => (progress: api.TransferProgress) => void;
  finishTransfer: (status: "complete" | "error" | "cancelled", id?: string | undefined) => void;
  load: (target: string, quiet?: boolean, resume?: boolean) => Promise<boolean>;
  failTransfer: (e: unknown, id?: string | undefined) => void;
  ownsTransfer: (id: string | undefined) => boolean;
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
  progressFor,
  finishTransfer,
  load,
  failTransfer,
  ownsTransfer,
  remoteIdRef,
  offlineReasonRef,
  updateTransferProgress,
  t,
}: Options) {
  const uploadPaths = async (localPaths: string[]) => {
    if (!remoteId || !path || busyRef.current || localPaths.length === 0) {
      return;
    }
    const destination = path;
    // The backend replaces a same-named file in place. Ask once for the whole
    // batch, the way a file manager does, instead of letting a drag overwrite
    // silently.
    const clashes = localPaths.filter((localPath) =>
      entries.some((entry) => entry.name === localFileName(localPath)),
    );
    if (clashes.length > 0) {
      const confirmed = await ask(
        t("filer.replaceConfirm", { count: clashes.length }),
        {
          title: t("filer.replaceTitle"),
          kind: "warning",
          okLabel: t("filer.replace"),
          cancelLabel: t("common.cancel"),
        },
      );
      if (!confirmed) return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer(
      "upload",
      localPaths.length === 1 ? localFileName(localPaths[0]) : `${localPaths.length} items`,
      true,
    );
    try {
      const items: api.TransferItem[] = localPaths.map((localPath) => ({
        local: localPath,
        remote: joinRemote(destination, localFileName(localPath)),
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
      finishTransfer("error");
      await load(destination);
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

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

  return { upload, uploadFolder, uploadPaths, copyPaths };
}
