import { useRef, useState, type FormEvent } from "react";
import { errorText } from "../errorInfo";

import * as api from "../api";
import type { AuthPrompt } from "../types";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  prompt: AuthPrompt;
  /** Takes the answered round off the queue, whatever the answer was. */
  onDone: () => void;
}

/**
 * One round of questions during an SSH login: a server's keyboard-interactive
 * challenge (a password, or a second factor — a verification code, a push
 * confirmation, a menu choice), or the password a profile does not hold. The
 * connection is stopped mid-handshake while this is open, and a server may
 * ask several rounds in a row, so the dialog is rebuilt for each one. Nothing
 * typed here is saved.
 */
export function AuthPromptDialog({ prompt, onDone }: Props) {
  const firstField = useRef<HTMLInputElement>(null);
  const t = useT();
  const [answers, setAnswers] = useState<string[]>(() => prompt.prompts.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Releases the waiting connection; it reports the cancelled login. */
  const cancel = () => {
    if (busy) return;
    void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
    onDone();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerAuthPrompt(prompt.id, answers);
      onDone();
    } catch (e) {
      // The round timed out or the session went away: there is nothing left
      // to answer, so let the user dismiss it.
      setError(errorText(e));
      setBusy(false);
    }
  };

  const title = prompt.name.trim() || t("auth.title");

  return (
    <ModalDialog
      open
      labelledBy="auth-prompt-title"
      contentClassName="confirm-dialog auth-prompt-dialog"
      onClose={cancel}
      dismissable={false}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-header" id="auth-prompt-title">
          {title}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            {t("auth.signingInTo")}
            <strong>{prompt.address}</strong>
            {t("auth.as")}
            <strong>{prompt.username}</strong>
            {t("auth.period")}
          </span>
          {prompt.instructions.trim() && (
            <p className="auth-prompt-instructions">{prompt.instructions}</p>
          )}
          {prompt.prompts.map((field, index) => (
            <label className="auth-prompt-field" key={index}>
              <span>{field.prompt.trim() || t("auth.response")}</span>
              <input
                ref={index === 0 ? firstField : undefined}
                autoFocus={index === 0}
                type={field.echo ? "text" : "password"}
                value={answers[index]}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) =>
                  setAnswers((previous) =>
                    previous.map((answer, at) => (at === index ? event.target.value : answer)),
                  )
                }
              />
            </label>
          ))}
          <span className="confirm-dialog-hint">{t("auth.hint")}</span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Esc</kbd> {t("keys.cancel")}
          </span>
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {busy ? t("auth.sending") : t("auth.continue")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
