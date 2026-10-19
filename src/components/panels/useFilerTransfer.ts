import type { Dispatch, SetStateAction } from "react";
import { errorText, isCancelled } from "../../errorInfo";
import { useEffect, useRef, useState } from "react";
import * as api from "../../api";
import { useFileTransfers } from "../../fileTransfers";
import type { Translate } from "../../i18n";
import { useStableCallback } from "../../useStableCallback";
import { transferLabels } from "./filerPresentation";
import type { ActiveTransfer, TransferState } from "./filerTypes";
import { TransferRateSample } from "./filerTypes";

interface Options {
  setError: Dispatch<SetStateAction<string | null>>;
  /** The line the panel is showing, so a functional update can be resolved. */
  error: string | null;
  t: Translate;
}

export function useFilerTransfer({ setError, error, t }: Options) {
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const remoteEditRef = useRef<(event: api.RemoteEditEvent) => void>(() => {});
  const transferClearTimer = useRef<number | null>(null);
  const transferRateSamples = useRef<TransferRateSample[]>([]);
  const activeTransfer = useRef<ActiveTransfer | null>(null);
  const visibleTransferId = useRef<string | undefined>(undefined);
  /**
   * How to run the failed transfer again, registered by the caller that
   * started it. A failure used to leave the user with an error line whose
   * Retry only reloaded the listing, so the upload had to be rebuilt by hand
   * from the file picker; the footer now keeps the failed transfer and the
   * operation that produced it.
   */
  const retryRef = useRef<(() => void) | null>(null);
  const ownsTransfer = (id: string | undefined) => visibleTransferId.current === id;
  const backgroundTransfer = useFileTransfers((s) => s.jobs[activeTransfer.current?.id ?? ""]);

  /**
   * Shows `kind` starting in the footer. A cancellable transfer (the SFTP
   * and FTP copies) gets the id to pass along; the footer's Cancel button
   * and a released drag reach it through `cancelTransfer`. `retry` is what
   * the footer's Retry button runs after a failure.
   */
  const beginTransfer = (
    kind: TransferState["kind"],
    name: string,
    cancellable = false,
    retry?: () => void,
  ): string | undefined => {
    if (transferClearTimer.current !== null) {
      window.clearTimeout(transferClearTimer.current);
      transferClearTimer.current = null;
    }
    retryRef.current = retry ?? null;
    activeTransfer.current = cancellable ? { id: api.newTransferId(), cancelled: false } : null;
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
    transferRateSamples.current = [{ time: performance.now(), transferred: 0 }];
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
    } else if (progress.transferred !== latest.transferred || now - latest.time >= 250) {
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
        ? Math.max(0, (progress.transferred - oldest.transferred) / elapsedSeconds)
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

  const finishTransfer = (
    status: "complete" | "error" | "cancelled",
    id = visibleTransferId.current,
  ) => {
    if (!ownsTransfer(id)) return;
    activeTransfer.current = null;
    if (status !== "error") retryRef.current = null;
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred:
              status === "complete" && current.total > 0 ? current.total : current.transferred,
            status,
          }
        : current,
    );
    // A failure stays in the footer until the next transfer replaces it: the
    // three-second blink it used to get was over before the user had read
    // it, and the Retry button needs a stable target to sit beside.
    if (status === "error") return;
    transferClearTimer.current = window.setTimeout(
      () => {
        setTransfer(null);
        transferClearTimer.current = null;
      },
      1800,
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

  /** Runs the failed transfer again; a no-op when none is on offer. */
  const retryTransfer = useStableCallback(() => {
    retryRef.current?.();
  });

  /**
   * Reports an error that is not the footer's transfer. It takes the error
   * line over from a transfer that failed earlier, so the line's Retry goes
   * back to reloading the listing instead of re-running that transfer.
   * Clearing the line (a reload that succeeded) leaves the retry alone.
   * It fills a `setError` slot, so React's functional form is accepted and
   * resolved against the line the panel already shows.
   */
  const reportError = useStableCallback((message: SetStateAction<string | null>) => {
    const line = typeof message === "function" ? message(error) : message;
    if (line !== null) retryRef.current = null;
    setError(line);
  });

  /** Ends the transfer a rejection belongs to: cancelled, or failed with `e`. */
  const failTransfer = (e: unknown, id = visibleTransferId.current) => {
    if (!ownsTransfer(id)) return;
    if (activeTransfer.current?.cancelled || isCancelled(e)) {
      finishTransfer("cancelled");
      return;
    }
    setError(errorText(e));
    finishTransfer("error");
  };

  useEffect(
    () => () => {
      if (transferClearTimer.current !== null) {
        window.clearTimeout(transferClearTimer.current);
      }
    },
    [],
  );

  // Progress of remote files edited locally, whichever tab is active: the
  // footer shows the save going out, and a failure lands in the error line.
  remoteEditRef.current = (event) => {
    if (activeTransfer.current) return;
    if (event.status === "uploading") {
      beginTransfer("sync", event.name);
    } else if (event.status === "synced") {
      finishTransfer("complete");
    } else if (event.status === "kept") {
      reportError(
        t("filer.remoteEditKept", {
          name: event.name,
          message: event.message ?? t("filer.localCopyKept"),
        }),
      );
    } else {
      reportError(
        t("filer.remoteEditSync", {
          name: event.name,
          message: event.message ?? t("filer.syncFailed"),
        }),
      );
      finishTransfer("error");
    }
  };

  useEffect(() => {
    const unlisten = api.onRemoteEditState((event) => remoteEditRef.current(event));
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))
        : null
    : null;
  const transferLabel = transfer ? transferLabels(t)[transfer.kind][transfer.status] : "";
  // Whether the footer's failure can be run again. The ref rides along with
  // the transfer state, so the two never disagree about what is on offer.
  const retryAvailable = transfer?.status === "error" && retryRef.current !== null;

  return {
    beginTransfer,
    progressFor,
    finishTransfer,
    failTransfer,
    ownsTransfer,
    updateTransferProgress,
    activeTransfer,
    cancelTransfer,
    retryTransfer,
    retryAvailable,
    reportError,
    transfer,
    transferLabel,
    transferPercent,
    backgroundTransfer,
  };
}
