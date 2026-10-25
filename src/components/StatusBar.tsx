import { memo, useEffect, useState } from "react";

import * as api from "../api";
import { t as translateMsg } from "../i18n";
import { useActiveTab, useStore } from "../store";
import { isFileSession, type LegacyAlgorithms } from "../types";
import { useT } from "../useT";
import { Icon } from "./icons";
import { TransferCenter } from "./TransferCenter";
import { ResourceMonitorBar } from "./ResourceMonitorBar";
import { ForwardCenter } from "./ForwardCenter";

/** The folder half of a recording's path, for the Reveal click. */
const parentDir = (path: string): string => path.replace(/[\\/][^\\/]*$/, "") || path;

/** The tooltip naming each server's legacy algorithms, one server a line. */
const legacyTitle = (servers: LegacyAlgorithms[]): string =>
  [
    translateMsg("status.legacyAlgorithms"),
    ...servers.map(({ address, algorithms }) => `${address}: ${algorithms.join(", ")}`),
  ].join("\n");

function StatusBarBase({ showResources = true }: { showResources?: boolean }) {
  const t = useT();
  const tab = useActiveTab();
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const setStatus = useStore((s) => s.setStatus);
  const [clock, setClock] = useState(() => new Date());

  // A success or an ordinary notice clears itself; an error stays until it is
  // dismissed, because it says something went wrong and the user has to see
  // what. The timer restarts on every new message, so a message arriving
  // while another is showing still gets its full three seconds.
  useEffect(() => {
    if (!status || error) return;
    const timer = window.setTimeout(() => setStatus(""), 3000);
    return () => window.clearTimeout(timer);
  }, [status, error, setStatus]);

  // The stamp only shows minutes, so ticking every second would re-render the
  // whole bar 59 times for no visible change. Wake up on the next minute
  // boundary, then once per minute; both timer kinds are cleared on unmount.
  useEffect(() => {
    const now = new Date();
    const toNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setClock(new Date());
      interval = window.setInterval(() => setClock(new Date()), 60_000);
    }, toNextMinute);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  // Locale-aware stamp: the previous hand-rolled YYYY/M/D read as a
  // non-localized format in en and jittered against the protocol width.
  // toLocaleString follows the OS locale; fall back to the old shape only
  // when Intl is unavailable.
  let stamp: string;
  try {
    stamp = clock.toLocaleString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    stamp = `${clock.getFullYear()}/${clock.getMonth() + 1}/${clock.getDate()} ${pad(
      clock.getHours(),
    )}:${pad(clock.getMinutes())}`;
  }

  const recording = tab?.state === "connected" ? tab.info.recording : null;
  const legacy = tab?.state === "connected" ? tab.info.legacyAlgorithms : [];

  return (
    <div className="statusbar" data-focus-region="status" tabIndex={-1}>
      <span
        className={`status-item status-message${error ? " is-error" : ""}`}
        title={error ?? status}
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        <span className="status-message-text">{error ?? status}</span>
        {error && (
          <button
            type="button"
            className="status-dismiss"
            title={t("status.dismissError")}
            aria-label={t("status.dismissError")}
            onClick={() => setError(null)}
          >
            <Icon name="close" />
          </button>
        )}
      </span>
      {showResources && <ResourceMonitorBar tab={tab} />}
      <ForwardCenter />
      <TransferCenter />
      {tab && (
        /* The session's own details read as one cluster at the right end of
           the bar, so they are grouped tighter than the bar's own step. */
        <div className="status-group">
          {legacy.length > 0 && (
            <span className="status-item status-legacy" title={legacyTitle(legacy)}>
              <Icon name="warning" />
              {t("status.legacySsh")}
            </span>
          )}
          {recording && (
            <button
              type="button"
              className="status-item status-recording"
              title={t("status.recordingTitle", { path: recording })}
              onClick={() => void api.openLocalPath(parentDir(recording)).catch(() => undefined)}
            >
              <Icon name="record" />
              {t("status.recording")}
            </button>
          )}
          {!isFileSession(tab.info.kind) && (
            <span className="status-item">
              {t("status.window", { cols: tab.cols, rows: tab.rows })}
            </span>
          )}
          <span
            className="status-item status-protocol"
            title={`${t("status.protocol")}: ${tab.info.protocol.toUpperCase()}`}
          >
            {tab.info.protocol.toUpperCase()}
          </span>
        </div>
      )}
      <span className="status-item">{stamp}</span>
    </div>
  );
}

// Memoised: the one prop changes only when the workbench takes over host
// sampling, so the app's other re-renders skip the bar.
export const StatusBar = memo(StatusBarBase);
