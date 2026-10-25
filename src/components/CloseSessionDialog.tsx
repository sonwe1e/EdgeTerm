import { tabTitle, type Tab } from "../store";
import { useT } from "../useT";
import { ModalDialog } from "./ModalDialog";

interface Props {
  /** The live tabs about to close: one, or a strip's worth at once. */
  tabs: Tab[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** Names shown before a bulk close is summarised as "… and N more". */
const LISTED_TABS = 6;

/**
 * Confirmation shown before a live session tab is closed. Cancel holds
 * initial focus, so a stray Enter (from a ⌘W or a mis-click) cannot drop an
 * open SSH / serial / FTP session and its scrollback; the close button still
 * answers Enter once focused.
 */
export function CloseSessionDialog({ tabs, onConfirm, onCancel }: Props) {
  const t = useT();

  const single = tabs.length === 1 ? tabs[0] : null;
  const connecting = tabs.some((tab) => tab.state === "connecting");
  const connected = tabs.some((tab) => tab.state === "connected");
  const hint =
    connecting && connected
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
    <ModalDialog
      open
      role="alertdialog"
      labelledBy="close-session-title"
      contentClassName="confirm-dialog"
      onClose={onCancel}
      initialFocus=".btn:not(.is-danger)"
    >
      <div className="dialog-header" id="close-session-title">
        {single ? t("close.titleOne") : t("close.titleMany", { count: tabs.length })}
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
              {t("close.close")} <strong>{t("close.sessionsCount", { count: tabs.length })}</strong>
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
          <kbd>Esc</kbd> {t("keys.cancel")}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn is-danger" onClick={onConfirm}>
          {t("common.close")}
        </button>
      </div>
    </ModalDialog>
  );
}
