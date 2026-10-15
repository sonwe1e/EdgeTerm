import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

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
import { useT } from "../useT";
import { Icon } from "./icons";
import { ModalDialog } from "./ModalDialog";

interface Props {
  bindings: ShortcutBindings;
  onApply: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

/** The shortcuts this dialog cannot change, shown so they are not hunted for. */
const FIXED_SHORTCUTS: { keys: string }[] = IS_MAC
  ? [{ keys: "⌘1–⌘9" }]
  : [{ keys: "Alt+1–Alt+9" }];

/**
 * Rebinds the application's keyboard shortcuts. A row records the next chord
 * pressed while it is armed; only the tab-number keys stay fixed (see
 * `chordProblem`).
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
    const problem = chordProblem(chord);
    if (problem) {
      setNotice(problem);
      return;
    }
    // One chord, one command: whoever held it before gives it up, so the
    // table can never be applied with two commands on the same keys.
    const taken = SHORTCUT_COMMANDS.find(
      ({ id }) => id !== command && sameChord(draft[id], chord),
    );
    setRecording(null);
    setNotice(
      taken
        ? t("sc.taken", { chord: chordLabel(chord), label: labels[taken.id] })
        : null,
    );
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
        <div className="dialog-header">{t("sc.title")}</div>
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
                    {armed
                      ? t("sc.pressKeys")
                      : chord
                        ? chordLabel(chord)
                        : t("sc.unassigned")}
                  </button>
                  <button
                    type="button"
                    className="shortcut-clear"
                    title={t("sc.removeShortcut")}
                    aria-label={t("sc.removeAria", { label: labels[id] })}
                    disabled={!chord}
                    onClick={() => unassign(id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>

          <p className="shortcuts-notice" role="status">
            {notice ??
              (recording
                ? t("sc.notice")
                : "")}
          </p>

          <div className="shortcuts-fixed">
            <strong>{t("sc.fixed")}</strong>
            {FIXED_SHORTCUTS.map(({ keys }) => (
              <span key={keys}>
                <kbd>{keys}</kbd> {t("sc.switchTab")}
              </span>
            ))}
          </div>
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
