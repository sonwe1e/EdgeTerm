import type { Dispatch, SetStateAction } from "react";
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
  t: Translate;
}

export function useFilerTransfer({ setError, t }: Options) {
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const remoteEditRef = useRef<(event: api.RemoteEditEvent) => void>(() => {});
  const transferClearTimer = useRef<number | null>(null);
  const transferRateSamples = useRef<TransferRateSample[]>([]);
  const activeTransfer = useRef<ActiveTransfer | null>(null);
  const visibleTransferId = useRef<string | undefined>(undefined);
  const ownsTransfer = (id: string | undefined) => visibleTransferId.current === id;
  const backgroundTransfer = useFileTransfers((s) => s.jobs[activeTransfer.current?.id ?? ""]);

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

  return {
    beginTransfer,
    progressFor,
    finishTransfer,
    failTransfer,
    ownsTransfer,
    updateTransferProgress,
    activeTransfer,
    cancelTransfer,
    transfer,
    transferLabel,
    transferPercent,
    backgroundTransfer,
  };
}
