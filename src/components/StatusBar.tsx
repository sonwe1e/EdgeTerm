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
const parentDir = (path: string): string =>
  path.replace(/[\\/][^\\/]*$/, "") || path;

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
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${clock.getFullYear()}/${clock.getMonth() + 1}/${clock.getDate()} ${pad(
    clock.getHours(),
  )}:${pad(clock.getMinutes())}`;

  const recording = tab?.state === "connected" ? tab.info.recording : null;
  const legacy = tab?.state === "connected" ? tab.info.legacyAlgorithms : [];

  return (
    <div className="statusbar">
      <span className={`status-item${error ? " is-error" : ""}`} title={error ?? status}>
        {error ?? status}
      </span>
      <div className="status-spacer" />
      {showResources && <ResourceMonitorBar tab={tab} />}
      <ForwardCenter />
      <TransferCenter />
      {tab && (
        <>
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
              onClick={() =>
                void api.openLocalPath(parentDir(recording)).catch(() => undefined)
              }
            >
              <Icon name="record" />
              REC
            </button>
          )}
          {isFileSession(tab.info.kind) ? (
            <span className="status-item">{t("status.dualPane")}</span>
          ) : (
            <span className="status-item">
              {t("status.window", { rows: tab.rows, cols: tab.cols })}
            </span>
          )}
          <span className="status-item">{tab.info.protocol}</span>
        </>
      )}
      <span className="status-item">{stamp}</span>
    </div>
  );
}

// Memoised: the one prop changes only when the workbench takes over host
// sampling, so the app's other re-renders skip the bar.
export const StatusBar = memo(StatusBarBase);
