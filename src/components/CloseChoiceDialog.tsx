import { useState } from "react";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  /**
   * `tray` hides the window (sessions keep running); `exit` continues into
   * the existing quit flow, which still confirms live sessions.
   */
  onChoice: (choice: "tray" | "exit", remember: boolean) => void;
  onCancel: () => void;
}

/**
 * What closing the window should do, asked every time while the "minimize to
 * tray" setting is off (the default): park the app in the system tray with
 * every session running, or quit. "Remember my choice" writes the picked
 * action as the setting, so the dialog stops appearing either way; the
 * settings menu puts the choice back on "ask".
 */
export function CloseChoiceDialog({ onChoice, onCancel }: Props) {
  const t = useT();
  const [remember, setRemember] = useState(false);

  return (
    <ModalDialog
      open
      role="dialog"
      labelledBy="close-choice-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      initialFocus=".btn:not(.is-danger)"
    >
      <div className="dialog-header" id="close-choice-title">
        {t("closeChoice.title")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>{t("closeChoice.body")}</span>
        <label className="confirm-dialog-hint close-choice-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />{" "}
          {t("closeChoice.remember")}
        </label>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Esc</kbd> {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn" onClick={() => onChoice("tray", remember)}>
          {t("closeChoice.tray")}
        </button>
        <button type="button" className="btn is-danger" onClick={() => onChoice("exit", remember)}>
          {t("closeChoice.exit")}
        </button>
      </div>
    </ModalDialog>
  );
}
