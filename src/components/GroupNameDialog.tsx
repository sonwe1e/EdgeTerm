import { useEffect, useRef, useState } from "react";
import { errorText } from "../errorInfo";

import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  title: string;
  /** Where the group lives, e.g. "SSH Sessions / prod". */
  location: string;
  initialName?: string;
  /** Overrides the group-specific field label for other naming prompts. */
  label?: string;
  /** Overrides the "in {location}" hint when the caller has a better one. */
  hint?: string;
  submitLabel: string;
  /** Rejections are shown inline and keep the dialog open. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

/** Asks for a name when creating or renaming a group, folder or remote item. */
export function GroupNameDialog({
  title,
  location,
  initialName = "",
  label,
  hint,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  useEffect(() => {
    // The show-modal focus algorithm puts focus here (autofocus); select so
    // renaming starts by overwriting the current name.
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("groupName.error"));
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      open
      labelledBy="group-name-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      dismissable={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-header" id="group-name-title">
          {title}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <label className="session-field is-wide">
            <span className="session-field-label">
              {label ?? t("groupName.nameLabel")}
            </span>
            <input
              ref={inputRef}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              placeholder={t("groupName.placeholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <span className="confirm-dialog-hint">
            {hint ?? t("groupName.in", { location })}
          </span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {submitLabel.toLowerCase()} · <kbd>Esc</kbd>{" "}
            {t("keys.cancel")}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
