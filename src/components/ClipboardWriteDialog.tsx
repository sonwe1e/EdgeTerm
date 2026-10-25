import { useState } from "react";

import { pasteLines } from "../terminalPaste";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  /** The session's tab title, so the user knows which program asks. */
  session: string;
  /** What the program wants on the clipboard. */
  text: string;
  /** Writes it; `always` also lets every program do so from now on. */
  onAllow: (always: boolean) => void;
  onDeny: () => void;
}

const PREVIEW_LINES = 6;
const PREVIEW_COLUMNS = 120;

/**
 * Asked the first time a session's program sets the clipboard with OSC 52
 * (issue #65), the way WindTerm asks. Allowing covers the rest of the
 * session, since a program that copies (tmux, an agent's copy mode) does so
 * on every selection.
 *
 * Deny holds initial focus and Enter is not bound to Allow: the prompt is
 * raised by a remote program, so a keystroke meant for the shell must not
 * grant a clipboard write. Esc denies; Allow is an explicit click or Enter
 * on the focused Allow button.
 */
export function ClipboardWriteDialog({ session, text, onAllow, onDeny }: Props) {
  const [always, setAlways] = useState(false);
  const t = useT();

  const preview = pasteLines(text);
  const shown = preview.slice(0, PREVIEW_LINES);

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="clipboard-write-title"
      contentClassName="confirm-dialog paste-warning-dialog"
      onClose={onDeny}
      initialFocus=".confirm-dialog-footer .btn:not(.is-primary)"
    >
      <div className="dialog-header" id="clipboard-write-title">
        {t("clipboardWrite.title")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>
          {t("clipboardWrite.aProgramIn")}
          <strong>{session}</strong>
          {t("clipboardWrite.wantsToCopy")}
          {t("common.characters", { count: text.length.toLocaleString() })}
          {t("clipboardWrite.toClipboard")}
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
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
          />
          <span>{t("clipboardWrite.alwaysAllow")}</span>
        </label>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Esc</kbd> {t("keys.deny")}
        </span>
        <button type="button" className="btn" onClick={onDeny}>
          {t("clipboard.deny")}
        </button>
        <button type="button" className="btn is-primary" onClick={() => onAllow(always)}>
          {t("clipboard.allow")}
        </button>
      </div>
    </ModalDialog>
  );
}
