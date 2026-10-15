import { useEffect, useRef, useState } from "react";

import type { HostKeyPrompt } from "../store";
import { useT } from "../useT";

interface Props {
  prompt: HostKeyPrompt;
  /** Records the new key and reconnects; rejects if known_hosts can't be updated. */
  onAccept: () => Promise<void>;
  onCancel: () => void;
}

/** The file under /etc/ssh whose fingerprint the user can compare against. */
function serverKeyFile(keyType: string): string {
  const family = ["ed25519", "ecdsa", "rsa"].find((name) =>
    keyType.includes(name),
  );
  return `/etc/ssh/ssh_host_${family ?? "<type>"}_key.pub`;
}

/**
 * Shown when an SSH server presents a key that differs from the one recorded
 * for it. The safe answer is the default: Cancel has focus, Esc cancels, and
 * accepting takes a deliberate click.
 */
export function HostKeyDialog({ prompt, onAccept, onCancel }: Props) {
  const { change } = prompt;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => {
    // Pull focus out of whatever was active so keystrokes reach the dialog.
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      // On success the prompt is cleared and this dialog unmounts.
      await onAccept();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="dialog confirm-dialog host-key-dialog"
        role="alertdialog"
        aria-labelledby="host-key-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="host-key-title">
          {t("hostKey.title")}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            <strong>
              {change.host}:{change.port}
            </strong>
            {t("hostKey.presented")}
          </span>
          <dl className="host-key-facts">
            <dt>{t("hostKey.newKey")}</dt>
            <dd>
              {change.keyType} {change.fingerprint}
            </dd>
            <dt>{t("hostKey.recordedIn")}</dt>
            <dd>
              {t("hostKey.recordedInValue", {
                file: change.knownHosts,
                line: change.line,
              })}
            </dd>
          </dl>
          <span className="confirm-dialog-hint">
            {t("hostKey.hintStart")}
            <code>ssh-keygen -lf {serverKeyFile(change.keyType)}</code>
            {t("hostKey.hintEnd")}
          </span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Esc</kbd> {t("keys.cancel")}
          </span>
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn is-danger"
            onClick={() => void accept()}
            disabled={busy}
          >
            {busy ? t("hostKey.accepting") : t("hostKey.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
