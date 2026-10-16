import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { useFileTransfers } from "./fileTransfers";
import { t } from "./i18n";
import { open, save } from "./nativeDialog";
import { useStore } from "./store";
import type { FileEntry } from "./types";
import { useStableCallback } from "./useStableCallback";

/** Only choosing a destination blocks this entry; submitted jobs belong to the backend queue. */
export function useFilerDownloads(sessionId: string | null, onError: (error: string | null) => void) {
  const [choosing, setChoosing] = useState(false);
  const choosingRef = useRef(false);
  const alive = useRef(false);
  const context = useRef({ sessionId, revision: 0 });
  if (context.current.sessionId !== sessionId) {
    context.current = { sessionId, revision: context.current.revision + 1 };
  }
  const report = useStableCallback(onError);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; context.current.revision++; };
  }, []);

  const download = useStableCallback(async (entries: readonly FileEntry[]) => {
    const source = sessionId;
    if (!source || entries.length === 0 || choosingRef.current) return;
    const revision = context.current.revision;
    const name = entries.length === 1 ? entries[0].name : t("filer.selectedCount", { count: entries.length });
    const current = () => alive.current && context.current.sessionId === source && context.current.revision === revision;
    choosingRef.current = true;
    setChoosing(true);
    report(null);
    try {
      let items: api.TransferItem[];
      if (entries.length === 1 && !entries[0].isDir) {
        const target = await save({ defaultPath: entries[0].name });
        if (!target || !current()) return;
        items = [{ local: target, remote: entries[0].path, upload: false, directory: false }];
      } else {
        const parent = await open({ directory: true, multiple: false, title: entries.length === 1
          ? t("filer.saveFolderInto", { name }) : t("filer.saveSelectedInto") });
        if (typeof parent !== "string" || !current()) return;
        const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
        items = entries.map((entry) => ({
          local: `${parent.replace(/[\\/]+$/, "")}${separator}${entry.name}`,
          remote: entry.path, upload: false, directory: entry.isDir,
        }));
      }
      const transfer = api.newTransferId();
      // Do not await completion or use the panel's one-transfer progress slot.
      // Subscription snapshots drive the transfer center even after this panel unmounts.
      void api.transferFiles(source, items, () => {}, transfer).catch((error) => {
        const status = useFileTransfers.getState().jobs[transfer]?.status;
        if (status === "cancelled" || status === "cancelling" || String(error).includes("transfer cancelled")) return;
        useStore.getState().setError(t("filer.downloadFailed", { name, error: String(error) }), source);
      });
    } catch (error) {
      if (current()) report(String(error));
    } finally {
      choosingRef.current = false;
      if (alive.current) setChoosing(false);
    }
  });
  return { download, choosing };
}
