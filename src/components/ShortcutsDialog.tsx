import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { KEY_REFERENCE } from "../keyReference";
import { IS_MAC } from "../platform";
import {
  chordFromEvent,
  chordLabel,
  chordProblem,
  defaultShortcuts,
  sameChord,
  SHORTCUT_COMMANDS,
  shortcutHints,
  shortcutLabels,
  type ShortcutBindings,
  type ShortcutCommand,
} from "../shortcuts";
import type { MessageKey } from "../i18n";
import { useT } from "../useT";
import { Icon } from "./icons";
import { ModalDialog } from "./ModalDialog";

interface Props {
  bindings: ShortcutBindings;
  onApply: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

/** The shortcuts this dialog cannot change, shown so they are not hunted for. */
const FIXED_SHORTCUTS: { keys: string; labelKey?: MessageKey }[] = [
  { keys: IS_MAC ? "⌘1–⌘9" : "Alt+1–Alt+9" },
  // Answered before the table is consulted and refused to every other command,
  // so it cannot be rebound — listing it here is how a reader learns that.
  { keys: IS_MAC ? "F6 / ⇧F6" : "F6 / Shift+F6", labelKey: "sc.focusRegionFixed" },
];

/**
 * Rebinds the application's keyboard shortcuts. A row records the next chord
 * pressed while it is armed, except for reserved chords (see `chordProblem`).
 */
export function ShortcutsDialog({ bindings, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<ShortcutBindings>(() => ({ ...bindings }));
  const [recording, setRecording] = useState<ShortcutCommand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = useT();
  const labels = shortcutLabels(t);
  const hints = shortcutHints(t);

  const onRecordedKey = (event: KeyboardEvent, command: ShortcutCommand) => {
    // Every key belongs to the row being recorded, so nothing reaches the
    // window shortcut handler, the browser or the terminal underneath.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    const chord = chordFromEvent(event);
    if (!chord) return;
    const problem = chordProblem(chord, command);
    if (problem) {
      setNotice(problem);
      return;
    }
    // One chord, one command: whoever held it before gives it up, so the
    // table can never be applied with two commands on the same keys.
    const taken = SHORTCUT_COMMANDS.find(({ id }) => id !== command && sameChord(draft[id], chord));
    setRecording(null);
    setNotice(taken ? t("sc.taken", { chord: chordLabel(chord), label: labels[taken.id] }) : null);
    setDraft((current) => {
      const next = { ...current, [command]: chord };
      if (taken) next[taken.id] = null;
      return next;
    });
  };

  const unassign = (command: ShortcutCommand) => {
    setRecording(null);
    setNotice(null);
    setDraft((current) => ({ ...current, [command]: null }));
  };

  // The recording phase owns every key while armed (the row decides, nothing
  // underneath reacts); outside it, Escape closes through the primitive and
  // a backdrop press only flashes the dialog (the table is a draft).
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (recording) onRecordedKey(event.nativeEvent, recording);
  };

  return (
    <ModalDialog
      open
      labelledBy="shortcuts-title"
      contentClassName="shortcuts-dialog"
      onClose={onClose}
      dismissable={false}
      onKeyDown={onDialogKeyDown}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draft);
        }}
      >
        <div className="dialog-header" id="shortcuts-title">
          {t("sc.title")}
        </div>
        <div className="dialog-body shortcuts-dialog-body">
          <div className="shortcuts-list">
            {SHORTCUT_COMMANDS.map(({ id }) => {
              const chord = draft[id];
              const armed = recording === id;
              return (
                <div key={id} className="shortcut-row">
                  <span className="shortcut-command">
                    <strong>{labels[id]}</strong>
                    <small>{hints[id]}</small>
                  </span>
                  <button
                    type="button"
                    className={`shortcut-key${armed ? " is-recording" : ""}${
                      !armed && !chord ? " is-unset" : ""
                    }`}
                    aria-label={t("sc.ariaLabel", { label: labels[id] })}
                    onClick={() => {
                      setNotice(null);
                      setRecording(armed ? null : id);
                    }}
                  >
                    {armed ? t("sc.pressKeys") : chord ? chordLabel(chord) : t("sc.unassigned")}
                  </button>
                  <button
                    type="button"
                    className="shortcut-clear"
                    title={
                      id === "focusRegion" ? t("sc.focusRegionLocked") : t("sc.removeShortcut")
                    }
                    aria-label={t("sc.removeAria", { label: labels[id] })}
                    // F6 and Shift+F6 are answered by App itself and refused to
                    // every other command, so clearing this row would only look
                    // like it worked.
                    disabled={!chord || id === "focusRegion"}
                    onClick={(event) => {
                      // This button is about to disable itself; hand the keyboard
                      // to the row's chord button rather than the document.
                      const row = event.currentTarget.closest(".shortcut-row");
                      unassign(id);
                      requestAnimationFrame(() => {
                        row?.querySelector<HTMLButtonElement>(".shortcut-key")?.focus();
                      });
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>

          <p className="shortcuts-notice" role="status">
            {notice ?? (recording ? t("sc.notice") : "")}
          </p>

          <div className="shortcuts-fixed">
            <strong>{t("sc.fixed")}</strong>
            {FIXED_SHORTCUTS.map(({ keys, labelKey }) => (
              <span key={keys}>
                <kbd>{keys}</kbd> {t(labelKey ?? "sc.switchTab")}
              </span>
            ))}
          </div>

          {/* The keys the surface under the pointer answers. They cannot be
              rebound, so they are listed rather than editable; without this
              they were only discoverable by trying (see src/keyReference.ts). */}
          {KEY_REFERENCE.map((group) => (
            <div key={group.titleKey} className="shortcuts-fixed">
              <strong>{t(group.titleKey)}</strong>
              {group.entries.map((entry) => (
                <span key={entry.labelKey}>
                  <kbd>{entry.keys.join(" / ")}</kbd> {t(entry.labelKey)}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="dialog-footer shortcuts-dialog-footer">
          <button
            type="button"
            className="btn shortcuts-reset"
            onClick={() => {
              setRecording(null);
              setNotice(null);
              setDraft(defaultShortcuts());
            }}
          >
            {t("sc.resetDefaults")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn is-primary">
            {t("common.apply")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
