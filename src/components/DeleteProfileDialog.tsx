import { type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { SessionProfile } from "../types";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  profile: SessionProfile;
  /** One-line summary of the connection target, shown under the name. */
  target: string;
  /** Saved Sender commands scoped to this profile alone; they go with it. */
  scopedCommands: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown before a saved session profile is deleted. Enter
 * confirms and Esc cancels, so a stray click on the ✕ button no longer
 * silently drops a saved host and its credentials. Everything that belongs
 * to the profile goes with it, so the dialog spells out what that is.
 */
export function DeleteProfileDialog({
  profile,
  target,
  scopedCommands,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Enter") {
      // preventDefault keeps the focused button from also firing a click.
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    }
  };

  const commands =
    scopedCommands === 0
      ? ""
      : scopedCommands === 1
        ? t("deleteProfile.cmdOne")
        : t("deleteProfile.cmdMany", { count: scopedCommands });

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="delete-profile-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      onKeyDown={onKeyDown}
    >
      <div className="dialog-header" id="delete-profile-title">
        {t("deleteProfile.title")}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>
          {t("common.delete")} <strong>{profile.name}</strong>
          {t("common.question")}
        </span>
        <span className="confirm-dialog-target">
          {profile.kind} · {target}
        </span>
        <span className="confirm-dialog-hint">
          {t("deleteProfile.hintStart")}
          {commands}
          {t("deleteProfile.hintEnd")}
        </span>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Enter</kbd> {t("keys.delete")} · <kbd>Esc</kbd>{" "}
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
          {t("common.delete")}
        </button>
      </div>
    </ModalDialog>
  );
}
