import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import { tabTitle, useStore } from "../store";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

const LISTED_SESSIONS = 4;

/**
 * Confirmation shown when the app is asked to quit (window ✕, ⌘Q, Alt+F4)
 * while session tabs are still connecting or connected, so one stray gesture
 * cannot drop every open connection at once. Enter quits and Esc cancels.
 */
export function QuitConfirmDialog({ onConfirm, onCancel }: Props) {
  const tabs = useStore((s) => s.tabs);
  const t = useT();
  const live = tabs.filter(
    (tab) => tab.state === "connecting" || tab.state === "connected",
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Enter") {
      // preventDefault keeps the focused button from also firing a click.
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    }
  };

  const shown = live.slice(0, LISTED_SESSIONS);
  const extra = live.length - shown.length;

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="quit-app-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      onKeyDown={onKeyDown}
    >
      <div className="dialog-header" id="quit-app-title">
        {t("quit.title")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>
          {t("quit.with")}{" "}
          <strong>
            {live.length}
            {live.length === 1 ? t("quit.sessionOne") : t("quit.sessionMany")}
          </strong>
          {t("common.question")}
        </span>
        {shown.map((tab) => (
          <span key={tab.info.id} className="confirm-dialog-target">
            {tabTitle(tab)} · {tab.info.protocol}
          </span>
        ))}
        {extra > 0 && (
          <span className="confirm-dialog-target">
            {t("quit.andMore", { count: extra })}
          </span>
        )}
        <span className="confirm-dialog-hint">{t("quit.hint")}</span>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Enter</kbd> {t("keys.quit")} · <kbd>Esc</kbd>{" "}
          {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          autoFocus
          type="button"
          className="btn is-danger"
          onClick={onConfirm}
        >
          {t("common.quit")}
        </button>
      </div>
    </ModalDialog>
  );
}
