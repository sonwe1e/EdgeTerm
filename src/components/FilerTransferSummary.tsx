import { useMemo } from "react";
import { useFileTransfers } from "../fileTransfers";
import { useT } from "../useT";
import { Icon } from "./icons";

/** Read the scheduler's actual states, including tasks submitted from other panels. */
export function FilerTransferSummary({ sessionId }: { sessionId: string }) {
  const t = useT();
  const records = useFileTransfers((state) => state.jobs);
  const counts = useMemo(() => {
    const jobs = Object.values(records).filter((job) => job.sessionId === sessionId);
    return {
      total: jobs.length,
      running: jobs.filter((job) => ["running", "retrying", "pausing", "cancelling"].includes(job.status)).length,
      queued: jobs.filter((job) => job.status === "queued").length,
      paused: jobs.filter((job) => job.status === "paused").length,
      failed: jobs.filter((job) => job.status === "error").length,
    };
  }, [records, sessionId]);
  if (!counts.total) return null;
  const label = t("filer.transferQueueSummary", counts)
    + (counts.paused ? t("filer.transferQueuePaused", { count: counts.paused }) : "")
    + (counts.failed ? t("filer.transferQueueFailed", { count: counts.failed }) : "");
  return <div className="filer-transfer-summary">
    <button type="button" aria-label={t("filer.openTransferQueue")} title={label}
      onClick={() => useFileTransfers.getState().setOpen(true)}>
      <Icon name="cloud-download" /><span>{label}</span><Icon name="chevron-right" />
    </button>
    {/* The live region cannot live inside the button: `button` is a
        children-presentational role, so nothing within it is ever announced
        and this region was silent however many transfers were queued. */}
    <span className="sr-only" role="status">{label}</span>
  </div>;
}
