import { tabTitle, useStore } from "../store";
import { transferActive, useFileTransfers } from "../fileTransfers";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

const LISTED_SESSIONS = 4;

/**
 * Confirmation shown when the app is asked to quit (window ✕, ⌘Q, Alt+F4)
 * while sessions or background transfers are unfinished, so one stray gesture
 * cannot interrupt all of them. Cancel holds initial focus, so
 * Enter on an untouched dialog cancels rather than quits.
 */
export function QuitConfirmDialog({ onConfirm, onCancel }: Props) {
  const tabs = useStore((s) => s.tabs);
  const transfers = useFileTransfers(
    (s) => Object.values(s.jobs).filter((job) => transferActive(job.status)).length,
  );
  const t = useT();
  const live = tabs.filter((tab) => tab.state === "connecting" || tab.state === "connected");

  const shown = live.slice(0, LISTED_SESSIONS);
  const extra = live.length - shown.length;

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="quit-app-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      initialFocus=".btn:not(.is-danger)"
    >
      <div className="dialog-header" id="quit-app-title">
        {t("quit.title")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        {live.length > 0 && (
          <span>
            {t("quit.with")}{" "}
            <strong>
              {live.length}
              {live.length === 1 ? t("quit.sessionOne") : t("quit.sessionMany")}
            </strong>
            {t("common.question")}
          </span>
        )}
        {shown.map((tab) => (
          <span key={tab.info.id} className="confirm-dialog-target">
            {tabTitle(tab)} · {tab.info.protocol}
          </span>
        ))}
        {extra > 0 && (
          <span className="confirm-dialog-target">{t("quit.andMore", { count: extra })}</span>
        )}
        {live.length > 0 && <span className="confirm-dialog-hint">{t("quit.hint")}</span>}
        {transfers > 0 && (
          <span className="confirm-dialog-hint">{t("quit.transfers", { count: transfers })}</span>
        )}
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Esc</kbd> {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn is-danger" onClick={onConfirm}>
          {t("common.quit")}
        </button>
      </div>
    </ModalDialog>
  );
}
