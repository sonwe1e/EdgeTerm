import { useState } from "react";

import type { Snippet } from "../snippets";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

/**
 * Asks for the values of a parameterised command before anything reaches the
 * shell: `deploy {{env}}` is a question, and guessing the answer is worse than
 * asking. Send stays disabled until every value has been typed.
 */
export function SnippetArgsDialog({
  snippet,
  names,
  initial,
  onSubmit,
  onCancel,
}: {
  snippet: Snippet;
  names: string[];
  /** Values this command was last run with; retyping them is wasted work. */
  initial?: Record<string, string>;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initial }));
  const complete = names.every((name) => (values[name] ?? "").trim().length > 0);

  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  return (
    <ModalDialog
      open
      labelledBy="snippet-args-title"
      contentClassName="confirm-dialog snippet-args-dialog"
      dismissable={false}
      onClose={onCancel}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (complete) onSubmit(values);
        }}
      >
        <div className="dialog-header" id="snippet-args-title">
          {t("snippets.argsTitle", { name: snippet.name })}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <p className="confirm-dialog-hint">{t("snippets.argsHint")}</p>
          <code className="snippet-args-preview">{snippet.command}</code>
          {names.map((name, index) => (
            <label key={name} className="session-field is-wide">
              <span className="session-field-label">{name}</span>
              <input
                autoFocus={index === 0}
                aria-label={name}
                value={values[name] ?? ""}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => set(name, event.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {t("snippets.argsSend")} · <kbd>Esc</kbd> {t("keys.cancel")}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary" disabled={!complete}>
            {t("snippets.argsSend")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
