import type { FileEntry } from "../types";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  entry: FileEntry;
  entries?: readonly FileEntry[];
  /** Where the entry lives, shown next to its path: "local" or the session name. */
  location: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown before the Filer deletes a file or folder, whether the
 * request came from the toolbar or the row's context menu. The safe choice
 * (Cancel) holds initial focus, so Enter on an untouched dialog cancels; the
 * danger button still answers Enter once it is focused itself.
 */
export function DeleteEntryDialog({
  entry,
  entries,
  location,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  const multiple = entries && entries.length > 1;

  const kind = entry.isSymlink ? "link" : entry.isDir ? "folder" : "file";
  const title =
    kind === "folder"
      ? t("deleteEntry.titleFolder")
      : kind === "link"
        ? t("deleteEntry.titleLink")
        : t("deleteEntry.titleFile");
  // Both the local and the SFTP backend refuse to remove a folder with
  // anything in it, so say so rather than let the error explain afterwards.
  const hint =
    kind === "folder"
      ? t("deleteEntry.hintFolder")
      : kind === "link"
        ? t("deleteEntry.hintLink")
        : t("deleteEntry.hintFile");
  const kindWord =
    kind === "folder"
      ? t("deleteEntry.kindFolder")
      : kind === "link"
        ? t("deleteEntry.kindLink")
        : t("deleteEntry.kindFile");

  return (
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="delete-entry-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      initialFocus=".btn:not(.is-danger)"
    >
      <div className="dialog-header" id="delete-entry-title">
        {multiple ? t("deleteEntry.titleMany", { count: entries.length }) : title}
      </div>
      <div className="dialog-body confirm-dialog-body">
        <span>
          {multiple ? t("deleteEntry.confirmMany", { count: entries.length }) : <>
            {t("deleteEntry.delete")} {kindWord} <strong>{entry.name}</strong>
            {t("common.question")}
          </>}
        </span>
        <span className={`confirm-dialog-target${multiple ? " is-multiple" : ""}`}>
          {location} · {multiple ? entries.map((item) => item.path).join("\n") : entry.path}
        </span>
        <span className="confirm-dialog-hint">{multiple ? t("deleteEntry.hintMany") : hint}</span>
      </div>
      <div className="dialog-footer confirm-dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Esc</kbd> {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
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
