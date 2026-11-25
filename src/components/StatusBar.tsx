import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { copiedErrorText } from "../errorInfo";
import { revealLocalPath } from "../openExternal";
import { writeSystemClipboard } from "../systemClipboard";
import { t as translateMsg } from "../i18n";
import { broadcastTargets } from "../broadcast";
import { useActiveTab, useStore } from "../store";
import { isFileSession, type LegacyAlgorithms } from "../types";
import { useT } from "../useT";
import { Icon } from "./icons";
import { BroadcastTargets } from "./BroadcastTargets";
import { TransferCenter } from "./TransferCenter";
import { ResourceMonitorBar } from "./ResourceMonitorBar";
import { ForwardCenter } from "./ForwardCenter";
import { usePopoverDismiss } from "./usePopoverDismiss";
import { openAgentView } from "../agents/model";
import { latencyLabel, subscribeLatency } from "../inputLatency";

/** The folder half of a recording's path, for the Reveal click. */
const parentDir = (path: string): string => path.replace(/[\\/][^\\/]*$/, "") || path;

/** The tooltip naming each server's legacy algorithms, one server a line. */
const legacyTitle = (servers: LegacyAlgorithms[]): string =>
  [
    translateMsg("status.legacyAlgorithms"),
    ...servers.map(({ address, algorithms }) => `${address}: ${algorithms.join(", ")}`),
  ].join("\n");

function StatusBarBase() {
  const t = useT();
  const tab = useActiveTab();
  // The grid lives beside the tabs, not on the tab: see `AppStore.tabSizes`.
  const size = useStore((s) => (s.activeId ? s.tabSizes[s.activeId] : undefined));
  const status = useStore((s) => s.status);
  const broadcastInput = useStore((s) => s.broadcastInput);
  const setBroadcastInput = useStore((s) => s.setBroadcastInput);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const targetsRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(targetsOpen, () => setTargetsOpen(false), targetsRef);

  // Turning the mode off (indicator, chord, last recipient leaving) also closes
  // the targets list: it describes a mode that no longer exists.
  useEffect(() => {
    if (!broadcastInput) setTargetsOpen(false);
  }, [broadcastInput]);
  const broadcastCount = useStore(
    (s) =>
      broadcastTargets(s.tabs, s.activeId, s.broadcastExcluded, s.broadcastExcludedGroups).length,
  );
  const error = useStore((s) => s.error);
  const errorRequestId = useStore((s) => s.errorRequestId);
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

  // A batch operation reports every failure as one message joined by newlines,
  // and the bar shows one line of it. Say how many more there are, so a single
  // visible line does not read as a single failure; the copy button takes the
  // rest to wherever it is needed.
  const errorLines = error ? error.split("\n") : [];
  const errorRest = Math.max(0, errorLines.length - 1);

  const recording = tab?.state === "connected" ? tab.info.recording : null;
  const legacy = tab?.state === "connected" ? tab.info.legacyAlgorithms : [];
  // Typing latency, recomputed on new samples and when a reading goes stale.
  // The snapshot is the formatted string itself, so React compares cheaply.
  const latency = useSyncExternalStore(
    subscribeLatency,
    () =>
      latencyLabel(tab?.info.id ?? null, performance.now(), (ms) => t("status.latency", { ms })),
    () => "",
  );

  return (
    <div className="statusbar" data-focus-region="status" tabIndex={-1}>
      {/* An explicit `aria-live` overrides the role's implicit one, so a fixed
          `polite` held an error back behind the terminal's announcements: with
          output streaming, the polite queue rarely drains. An error takes the
          assertive lane; ordinary notices stay polite. */}
      <span
        className={`status-item status-message${error ? " is-error" : ""}`}
        title={error ?? status}
        role={error ? "alert" : "status"}
        aria-live={error ? "assertive" : "polite"}
      >
        <span className="status-message-text">{error ? errorLines[0] : status}</span>
        {errorRest > 0 && (
          <span className="status-message-more">
            {t("status.moreFailures", { count: errorRest })}
          </span>
        )}
        {error && (
          <>
            {/* The bar shows one line of a message that can be several (a batch
                delete lists every failure). The button is how the whole text
                reaches a bug report. */}
            <button
              type="button"
              className="status-dismiss"
              title={t("status.copyError")}
              aria-label={t("status.copyError")}
              onClick={() =>
                void writeSystemClipboard(copiedErrorText(error, errorRequestId)).catch(
                  () => undefined,
                )
              }
            >
              <Icon name="copy" />
            </button>
            <button
              type="button"
              className="status-dismiss"
              title={t("status.dismissError")}
              aria-label={t("status.dismissError")}
              onClick={() => {
                // Clearing the error unmounts this whole fragment, and the
                // button that had focus goes with it - the browser then drops
                // focus to the body, so the next Tab restarts the document from
                // the top and F6 re-enters the cycle at its first region. Every
                // failure the app raises is dismissed here, so hand the keyboard
                // back to the region the reader was already in.
                const wasInside = document.activeElement?.closest(".status-dismiss") != null;
                setError(null);
                if (wasInside) {
                  requestAnimationFrame(() =>
                    document.querySelector<HTMLElement>("[data-focus-region='status']")?.focus(),
                  );
                }
              }}
            >
              <Icon name="close" />
            </button>
          </>
        )}
      </span>
      {broadcastInput && (
        <>
          {/* A live mode with a blast radius stays in the bar while it is on:
              the indicator itself turns it off in one click. */}
          <button
            type="button"
            className="status-item is-broadcasting"
            title={t("broadcast.indicator", { count: broadcastCount })}
            aria-pressed="true"
            onClick={() => setBroadcastInput(false)}
          >
            <Icon name="broadcast" />
            {t("broadcast.indicator", { count: broadcastCount })}
          </button>
          {/* The recipients are editable beside it: "which shells" is the
              question a reader asks right after turning this on. */}
          <button
            type="button"
            className="status-item broadcast-targets-button"
            title={t("broadcast.chooseTargets")}
            aria-label={t("broadcast.chooseTargets")}
            aria-haspopup="true"
            aria-expanded={targetsOpen}
            onClick={() => setTargetsOpen(!targetsOpen)}
          >
            <Icon name="chevron-down" />
          </button>
          <div ref={targetsRef}>
            {targetsOpen && <BroadcastTargets onClose={() => setTargetsOpen(false)} />}
          </div>
        </>
      )}
      <ResourceMonitorBar tab={tab} />
      <ForwardCenter />
      <button
        type="button"
        className="status-item status-agent"
        title={t("agent.title")}
        onClick={() => openAgentView("compose")}
      >
        <Icon name="terminal" />
        {t("agent.title")}
      </button>
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
              data-recording-chip=""
              title={t("status.recordingTitle", { path: recording })}
              onClick={() => void revealLocalPath(parentDir(recording))}
            >
              <Icon name="record" />
              {t("status.recording")}
            </button>
          )}
          {tab.state === "connected" && tab.remoteTitle && (
            <span
              className="status-item status-remote-title"
              title={t("status.remoteTitle", { title: tab.remoteTitle })}
            >
              {tab.remoteTitle}
            </span>
          )}
          {!isFileSession(tab.info.kind) && latency && (
            <span className="status-item status-latency" title={t("status.latencyTitle")}>
              {latency}
            </span>
          )}
          {!isFileSession(tab.info.kind) && (
            <span className="status-item">
              {t("status.window", { cols: size?.cols ?? 80, rows: size?.rows ?? 24 })}
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

// Memoised: the one prop changes only when the active tab changes, so the
// app's other re-renders skip the bar.
export const StatusBar = memo(StatusBarBase);
