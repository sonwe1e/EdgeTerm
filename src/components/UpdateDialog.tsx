import type { UpdaterState } from "../updater";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  appVersion: string;
  state: UpdaterState;
  onDismiss: () => void;
  onOpenDownloads: () => void;
}

export function UpdateDialog({ appVersion, state, onDismiss, onOpenDownloads }: Props) {
  const t = useT();
  if (state.phase === "idle") return null;

  return (
    <ModalDialog
      open
      title={t("update.titleDefault")}
      labelledBy="update-dialog-title"
      contentClassName="update-dialog"
      onClose={onDismiss}
    >
      <div className="dialog-body update-dialog-body">
        {appVersion && <strong>{t("update.installed", { version: appVersion })}</strong>}
        <span>{t("update.manualHint")}</span>
        <span className="update-hint">{t("update.packageHint")}</span>
        {state.phase === "error" && <div className="dialog-error" role="alert">{state.message}</div>}
      </div>
      <div className="dialog-footer">
        <button className="btn" onClick={onDismiss}>{t("common.close")}</button>
        <button className="btn is-primary" onClick={onOpenDownloads}>
          {t("update.openDownload")}
        </button>
      </div>
    </ModalDialog>
  );
}
