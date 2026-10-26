import type { FileTransfer } from "./api";
import type { MessageKey, Translate } from "./i18n";

const phases: Record<string, MessageKey> = {
  connecting: "transfer.phaseConnecting",
  scanning: "transfer.phaseScanning",
  transferring: "transfer.phaseTransferring",
  "verifying resume prefix": "transfer.phaseVerifying",
  committing: "transfer.phaseCommitting",
  "probing remote tar": "transfer.phaseProbing",
  "tar streaming": "transfer.phaseStreaming",
};

export function transferPhase(job: FileTransfer, t: Translate): string | null {
  if (job.status !== "running") return null;
  const key = phases[job.phase];
  if (key) return t(key);
  if (job.phase.startsWith("restarting")) return t("transfer.phaseRestarting");
  if (job.phase.startsWith("per-file mode")) return t("transfer.phasePerFile");
  return t("transfer.statusRunning");
}

export function transferContext(job: FileTransfer, t: Translate): string {
  const context = job.context;
  if (!context) return t("transfer.contextUnavailable");
  const { firstUpload, local, server, protocol, itemCount, direction } = context;
  const label =
    direction === "mixed"
      ? t("transfer.directionMixed")
      : firstUpload
        ? t("transfer.directionUpload")
        : t("transfer.directionDownload");
  const remote = `${protocol} ${server} ${context.remote}`;
  const route = firstUpload ? `${local} → ${remote}` : `${remote} → ${local}`;
  return `${label} · ${route}${itemCount > 1 ? t("transfer.moreItems", { count: itemCount - 1 }) : ""}`;
}

export function transferIndeterminate(job: FileTransfer): boolean {
  return (
    job.status === "running" &&
    (job.total === 0 || ["connecting", "scanning", "probing remote tar"].includes(job.phase))
  );
}
