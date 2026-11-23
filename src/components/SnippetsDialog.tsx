import { useEffect, useRef, useState } from "react";

import { readClipboardText, writeClipboardText } from "../api";
import { opensFilter } from "../filterKey";
import type { MessageKey } from "../i18n";

import type { Snippet } from "../snippets";
import { MAX_COMMAND_LENGTH, MAX_NAME_LENGTH, copyName } from "../snippets";
import { exportSnippets, importSnippets } from "../snippetTransfer";
import { useStore } from "../store";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";
import { Icon } from "./icons";

/**
 * The saved-command list: add, edit, delete, and send. Clicking a row sends it
 * through the same funnel typing uses; the form is also the editor, so fixing
 * a command never means retyping it.
 */
export function SnippetsDialog({
  onClose,
  onRun,
}: {
  onClose: () => void;
  /** Runs a snippet: straight to the shell, or through its parameter prompt. */
  onRun: (snippet: Snippet) => void;
}) {
  const t = useT();
  const snippets = useStore((s) => s.snippets);
  const saveSnippet = useStore((s) => s.saveSnippet);
  const deleteSnippet = useStore((s) => s.deleteSnippet);
  const replaceSnippet = useStore((s) => s.replaceSnippet);
  const mergeSnippets = useStore((s) => s.importSnippets);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? snippets.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) || item.command.toLowerCase().includes(needle),
      )
    : snippets;

  // A duplicate is a copy under a free name, never a rename of the source:
  // names are how snippets are found, so overwriting one would be a surprise.
  const duplicate = (snippet: Snippet) => {
    // copyName only ever answers a free name, so this cannot overwrite: a
    // duplicate that replaced its source would be the worst kind of surprise.
    const copy = copyName(snippet.name, snippets);
    saveSnippet(copy, snippet.command);
    setError(null);
    setNotice(t("snippets.duplicated", { name: copy }));
  };

  const resetForm = () => {
    setName("");
    setCommand("");
    setEditingId(null);
    setError(null);
  };

  // Escape (and the Close button) steps back out of an edit before it closes
  // the manager, the way Escape already steps back from the filter: an edit is
  // a place the reader is in, and leaving it should not lose the list too.
  const requestClose = () => {
    if (editingId !== null) {
      resetForm();
      return;
    }
    onClose();
  };

  const submit = () => {
    if (!name.trim() || !command.trim()) return;
    if (editingId) {
      if (!replaceSnippet(editingId, name, command)) {
        setError(t("snippets.nameTaken"));
        return;
      }
    } else {
      saveSnippet(name, command);
    }
    resetForm();
  };

  // The clipboard is the transport: no file dialog, no path to remember.
  const copyAll = async () => {
    if (snippets.length === 0) return;
    try {
      await writeClipboardText(exportSnippets(snippets));
      setNotice(t("snippets.copied", { count: String(snippets.length) }));
      setError(null);
    } catch {
      setError(t("snippets.importFailed.clipboard"));
    }
  };

  const importFromClipboard = async () => {
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      setError(t("snippets.importFailed.clipboard"));
      return;
    }
    const result = importSnippets(text);
    if (!result.ok) {
      setError(t(("snippets.importFailed." + result.reason) as MessageKey));
      return;
    }
    const landed = mergeSnippets(result.entries);
    setError(null);
    setNotice(
      result.skipped > 0
        ? t("snippets.importedSkipped", { count: String(landed), skipped: String(result.skipped) })
        : t("snippets.imported", { count: String(landed) }),
    );
  };

  const nameRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const edit = (snippet: Snippet) => {
    setEditingId(snippet.id);
    setName(snippet.name);
    setCommand(snippet.command);
    setError(null);
  };

  // The form is the editor, so editing hands the reader the name already
  // selected: a rename is type-and-submit, not click-then-click-then-drag.
  // Done after the render that writes the row's text into the field, because
  // assigning a value moves the caret to its end.
  useEffect(() => {
    if (editingId === null) return;
    const field = nameRef.current;
    if (!field) return;
    field.focus();
    field.select();
  }, [editingId]);

  return (
    <ModalDialog
      open
      labelledBy="snippets-title"
      contentClassName="snippets-dialog"
      dismissable={false}
      onClose={requestClose}
    >
      <div className="dialog-header" id="snippets-title">
        {t("snippets.title")}
      </div>
      <div className="dialog-body snippets-body">
        <p className="snippets-hint">{t("snippets.hint")}</p>
        {snippets.length > 0 && (
          <input
            ref={filterRef}
            className="snippets-filter"
            aria-label={t("snippets.filterLabel")}
            placeholder={t("snippets.filterLabel")}
            aria-keyshortcuts="/"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              // Escape steps back to the whole list first, and only a second
              // press closes the dialog: the filter is part of the way in.
              if (event.key !== "Escape" || filter === "") return;
              event.preventDefault();
              event.stopPropagation();
              setFilter("");
            }}
          />
        )}
        {snippets.length === 0 ? (
          <div className="snippets-empty">
            <p>{t("snippets.empty")}</p>
            {/* The two quicker paths are where the reader already is; saying
                so here is what turns an empty list into a first saved command. */}
            <p className="snippets-empty-hint">{t("snippets.emptyHint")}</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="snippets-empty">{t("snippets.noMatches", { filter: filter.trim() })}</p>
        ) : (
          <ul className="snippets-list">
            {visible.map((snippet, index) => (
              <li key={snippet.id} className="snippets-row">
                <button
                  type="button"
                  className="snippets-send"
                  title={snippet.command}
                  data-snippet-id={snippet.id}
                  // F2 loads the row into the form and Delete removes it; the
                  // arrows between rows come with the list, so they stay out.
                  aria-keyshortcuts="F2 Delete"
                  onClick={() => onRun(snippet)}
                  onKeyDown={(event) => {
                    // A list that can only be walked with Tab is a list the
                    // keyboard cannot use for long; arrows move between rows and
                    // Delete removes the one under the cursor, the way every
                    // list in this app behaves.
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      const step = event.key === "ArrowDown" ? 1 : -1;
                      const next = visible[index + step];
                      if (!next) return;
                      event.preventDefault();
                      document
                        .querySelector<HTMLElement>(
                          '.snippets-send[data-snippet-id="' + next.id + '"]',
                        )
                        ?.focus();
                      return;
                    }
                    // "/" opens the filter (see `opensFilter`).
                    if (opensFilter(event)) {
                      event.preventDefault();
                      filterRef.current?.focus();
                      return;
                    }
                    // F2 is the rename key in every list of this app (the
                    // file panel, the session tree); here it loads the row into
                    // the form, which is where a saved command is edited.
                    if (event.key === "F2") {
                      event.preventDefault();
                      edit(snippet);
                      return;
                    }
                    if (event.key === "Delete" || event.key === "Backspace") {
                      // Backspace stays in the name/command fields; a row is a
                      // place where it can only mean "remove this one".
                      event.preventDefault();
                      deleteSnippet(snippet.id);
                      if (editingId === snippet.id) resetForm();
                    }
                  }}
                >
                  <span className="snippets-name">{snippet.name}</span>
                  <code className="snippets-command">{snippet.command}</code>
                </button>
                <button
                  type="button"
                  className="snippets-delete"
                  aria-label={t("snippets.duplicate", { name: snippet.name })}
                  title={t("snippets.duplicate", { name: snippet.name })}
                  onClick={() => duplicate(snippet)}
                >
                  <Icon name="copy" />
                </button>
                <button
                  type="button"
                  className="snippets-delete"
                  aria-label={t("snippets.edit", { name: snippet.name })}
                  title={t("snippets.edit", { name: snippet.name })}
                  onClick={() => edit(snippet)}
                >
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  className="snippets-delete"
                  aria-label={t("snippets.delete", { name: snippet.name })}
                  title={t("snippets.delete", { name: snippet.name })}
                  onClick={() => {
                    deleteSnippet(snippet.id);
                    if (editingId === snippet.id) resetForm();
                  }}
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="snippets-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={nameRef}
            className="snippets-name-input"
            aria-label={t("snippets.nameLabel")}
            placeholder={t("snippets.namePlaceholder")}
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="snippets-command-input"
            aria-label={t("snippets.commandLabel")}
            placeholder={t("snippets.commandPlaceholder")}
            value={command}
            maxLength={MAX_COMMAND_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            onChange={(event) => setCommand(event.target.value)}
          />
          {editingId && (
            <button type="button" className="btn" onClick={resetForm}>
              {t("common.cancel")}
            </button>
          )}
          <button type="submit" className="btn" disabled={!name.trim() || !command.trim()}>
            {editingId ? t("snippets.saveChanges") : t("snippets.add")}
          </button>
        </form>
        <div className="snippets-transfer">
          <button
            type="button"
            className="btn"
            disabled={snippets.length === 0}
            onClick={() => void copyAll()}
          >
            {t("snippets.copyAll")}
          </button>
          <button type="button" className="btn" onClick={() => void importFromClipboard()}>
            {t("snippets.importFromClipboard")}
          </button>
        </div>
        {notice && <div className="snippets-notice">{notice}</div>}
        {error && <div className="dialog-error">{error}</div>}
      </div>
      {/* A visible exit for readers who do not know Escape; the backdrop
          press deliberately does not discard a half-typed command. */}
      <div className="dialog-footer">
        <span className="confirm-dialog-keys">
          <kbd>Esc</kbd> {t("common.close")}
        </span>
        <button type="button" className="btn is-primary" onClick={requestClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
