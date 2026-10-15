import { useEffect, useRef } from "react";

import { tabTitle, type Tab } from "../store";
import { useT } from "../useT";

interface Props {
  /** The live tabs about to close: one, or a strip's worth at once. */
  tabs: Tab[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** Names shown before a bulk close is summarised as "… and N more". */
const LISTED_TABS = 6;

/**
 * Confirmation shown before a live session tab is closed. Enter confirms and
 * Esc cancels, so a stray ⌘W or a mis-click on the tab's ✕ can no longer
 * drop an open SSH / serial / FTP session and its scrollback without asking.
 */
export function CloseSessionDialog({ tabs, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => {
    // Pull focus out of the terminal so keystrokes reach the dialog.
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        // preventDefault keeps the focused button from also firing a click.
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm]);

  const single = tabs.length === 1 ? tabs[0] : null;
  const connecting = tabs.some((tab) => tab.state === "connecting");
  const connected = tabs.some((tab) => tab.state === "connected");
  const hint = connecting && connected
    ? t("close.hintMixed")
    : connecting
      ? tabs.length === 1
        ? t("close.hintConnectingOne")
        : t("close.hintConnectingMany")
      : tabs.length === 1
        ? t("close.hintOne")
        : t("close.hintMany");
  // A long list is summarised rather than scrolled: the names are a
  // reminder, the decision is the count.
  const listed = tabs.slice(0, LISTED_TABS);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-labelledby="close-session-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="close-session-title">
          {single
            ? t("close.titleOne")
            : t("close.titleMany", { count: tabs.length })}
        </div>
        <div className="dialog-body confirm-dialog-body">
          {single ? (
            <>
              <span>
                {t("close.close")} <strong>{single.info.name}</strong>
                {t("common.question")}
              </span>
              <span className="confirm-dialog-target">
                {single.info.protocol} · {single.info.address}
              </span>
            </>
          ) : (
            <>
              <span>
                {t("close.close")}{" "}
                <strong>{t("close.sessionsCount", { count: tabs.length })}</strong>
                {t("common.question")}
              </span>
              {listed.map((tab) => (
                <span className="confirm-dialog-target" key={tab.info.id}>
                  {tabTitle(tab)} · {tab.info.protocol} · {tab.info.address}
                </span>
              ))}
              {tabs.length > listed.length && (
                <span className="confirm-dialog-target">
                  {t("close.andMore", { count: tabs.length - listed.length })}
                </span>
              )}
            </>
          )}
          <span className="confirm-dialog-hint">{hint}</span>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {t("keys.close")} · <kbd>Esc</kbd>{" "}
            {t("keys.cancel")}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn is-danger"
            onClick={onConfirm}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
