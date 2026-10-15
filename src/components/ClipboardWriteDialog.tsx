import { useEffect, useRef, useState } from "react";

import { pasteLines } from "../terminalPaste";
import { useT } from "../useT";

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
 * Enter allows and Esc denies.
 */
export function ClipboardWriteDialog({ session, text, onAllow, onDeny }: Props) {
  const allowRef = useRef<HTMLButtonElement>(null);
  const [always, setAlways] = useState(false);
  const alwaysRef = useRef(always);
  alwaysRef.current = always;
  const t = useT();

  useEffect(() => {
    allowRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onAllow(alwaysRef.current);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDeny();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onAllow, onDeny]);

  const preview = pasteLines(text);
  const shown = preview.slice(0, PREVIEW_LINES);

  return (
    <div className="dialog-backdrop" onMouseDown={onDeny}>
      <div
        className="dialog confirm-dialog paste-warning-dialog"
        role="alertdialog"
        aria-labelledby="clipboard-write-title"
        onMouseDown={(event) => event.stopPropagation()}
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
                {line.length > PREVIEW_COLUMNS
                  ? `${line.slice(0, PREVIEW_COLUMNS)}…`
                  : line}
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
            <kbd>Enter</kbd> {t("keys.allow")} · <kbd>Esc</kbd> {t("keys.deny")}
          </span>
          <button type="button" className="btn" onClick={onDeny}>
            {t("clipboard.deny")}
          </button>
          <button
            ref={allowRef}
            type="button"
            className="btn is-primary"
            onClick={() => onAllow(always)}
          >
            {t("clipboard.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
