import type { UpdaterState } from "../updater";
import { useT } from "../useT";

interface Props {
  appVersion: string;
  portable: boolean;
  state: UpdaterState;
  onDismiss: () => void;
  onInstall: () => void;
  onCheckAgain: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function UpdateDialog({
  appVersion,
  portable,
  state,
  onDismiss,
  onInstall,
  onCheckAgain,
}: Props) {
  const t = useT();
  if (state.phase === "idle") return null;

  const busy = state.phase === "checking" || state.phase === "downloading";
  const dismissible = state.phase !== "downloading" && state.phase !== "installing";
  const progress =
    state.phase === "downloading" && state.total && state.total > 0
      ? Math.min(100, (state.downloaded / state.total) * 100)
      : undefined;

  let title = t("update.titleDefault");
  if (state.phase === "available") title = t("update.available");
  if (state.phase === "up-to-date") title = t("update.upToDate");
  if (state.phase === "error") title = t("update.failed");

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={() => dismissible && onDismiss()}
    >
      <div
        className="dialog update-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">{title}</div>
        <div className="dialog-body update-dialog-body">
          {state.phase === "checking" && (
            <>
              <div className="update-spinner" aria-hidden="true" />
              <span>{t("update.checking")}</span>
            </>
          )}

          {state.phase === "up-to-date" && (
            <span>
              {t("update.haveLatest")}
              {appVersion ? ` (${appVersion})` : ""}.
            </span>
          )}

          {state.phase === "available" && (
            <>
              <div className="update-version-row">
                <span>{t("update.installed", { version: state.currentVersion })}</span>
                <span aria-hidden="true">→</span>
                <strong>{t("update.latest", { version: state.version })}</strong>
              </div>
              {state.body && (
                <div className="update-notes" aria-label={t("update.releaseNotes")}>
                  {state.body}
                </div>
              )}
              <span className="update-hint">
                {portable ? t("update.portableHint") : t("update.hint")}
              </span>
            </>
          )}

          {state.phase === "downloading" && (
            <>
              <strong>{t("update.downloading", { version: state.version })}</strong>
              <progress
                className="update-progress"
                value={progress}
                max={100}
              />
              <span className="update-hint">
                {formatBytes(state.downloaded)}
                {state.total
                  ? t("update.ofTotal", { total: formatBytes(state.total) })
                  : t("update.downloadedSuffix")}
              </span>
            </>
          )}

          {state.phase === "installing" && (
            <>
              <div className="update-spinner" aria-hidden="true" />
              <span>{t("update.installing", { version: state.version })}</span>
            </>
          )}

          {state.phase === "error" && (
            <div className="dialog-error">{state.message}</div>
          )}
        </div>

        {!busy && state.phase !== "installing" && (
          <div className="dialog-footer">
            {state.phase === "error" && (
              <button className="btn" onClick={onCheckAgain}>
                {t("update.tryAgain")}
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn" onClick={onDismiss}>
                {t("update.later")}
              </button>
            )}
            {state.phase !== "available" && (
              <button className="btn" onClick={onDismiss}>
                {t("common.close")}
              </button>
            )}
            {state.phase === "available" && (
              <button className="btn is-primary" onClick={onInstall}>
                {portable ? t("update.openDownload") : t("update.downloadInstall")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
