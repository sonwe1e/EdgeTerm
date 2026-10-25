import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { pasteLineCount, pasteLines } from "../terminalPaste";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  /** The clipboard text waiting to go into the terminal. */
  text: string;
  /** Pastes it; `remember` also turns the warning off for good. */
  onConfirm: (remember: boolean) => void;
  onCancel: () => void;
}

/** Lines of the paste shown before the rest is summarised. */
const PREVIEW_LINES = 6;
/** How much of a line is shown; the rest is a tail the user cannot read anyway. */
const PREVIEW_COLUMNS = 120;

/**
 * Confirmation shown before a paste that would submit more than one command
 * (issue #63). The shell runs every line as it arrives, so a clipboard that
 * turned out to hold six lines is six commands on a production host — the
 * reason Windows Terminal, iTerm2 and Xshell all ask first.
 *
 * Enter pastes and Esc cancels, so the common answer costs one keystroke.
 */
export function PasteWarningDialog({ text, onConfirm, onCancel }: Props) {
  const [remember, setRemember] = useState(false);
  const t = useT();
  // Read once: the checkbox must not change what Enter does mid-keystroke.
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Enter") {
      // preventDefault keeps the focused button from also firing a click.
      event.preventDefault();
      event.stopPropagation();
      onConfirm(rememberRef.current);
    }
  };

  const lines = pasteLineCount(text);
  const preview = pasteLines(text);
  const shown = preview.slice(0, PREVIEW_LINES);

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="paste-warning-title"
      contentClassName="confirm-dialog paste-warning-dialog"
      onClose={onCancel}
      onKeyDown={onKeyDown}
    >
      <div className="dialog-header" id="paste-warning-title">
        {t("common.paste")}{" "}
        {lines > 1 ? t("pasteWarning.linesTitle", { count: lines }) : t("pasteWarning.longText")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>
          {lines > 1 ? (
            <>
              {t("pasteWarning.holds")}
              <strong>{t("pasteWarning.linesCount", { count: lines })}</strong>
              {t("pasteWarning.charsParen", {
                count: text.length.toLocaleString(),
              })}
              {t("pasteWarning.everyLine")}
            </>
          ) : (
            <>
              {t("pasteWarning.holds")}
              <strong>{t("common.characters", { count: text.length.toLocaleString() })}</strong>
              {t("pasteWarning.onOneLine")}
            </>
          )}
        </span>
        <pre className="paste-warning-preview">
          {shown.map((line, index) => (
            <span key={index}>
              {line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line}
              {"\n"}
            </span>
          ))}
          {preview.length > shown.length && (
            <span className="paste-warning-more">
              {t("pasteWarning.andMoreLines", {
                count: preview.length - shown.length,
              })}
            </span>
          )}
        </pre>
        <label className="paste-warning-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>{t("pasteWarning.dontWarn")}</span>
        </label>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Enter</kbd> {t("keys.paste")} · <kbd>Esc</kbd> {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          autoFocus
          type="button"
          className="btn is-primary"
          onClick={() => onConfirm(remember)}
        >
          {t("common.paste")}
        </button>
      </div>
    </ModalDialog>
  );
}
