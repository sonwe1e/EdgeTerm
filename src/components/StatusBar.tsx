import { memo, useEffect, useState } from "react";

import * as api from "../api";
import { useActiveTab, useStore } from "../store";
import { isFileSession, type LegacyAlgorithms } from "../types";
import { Icon } from "./icons";
import { TransferCenter } from "./TransferCenter";
import { ForwardCenter } from "./ForwardCenter";

/** The folder half of a recording's path, for the Reveal click. */
const parentDir = (path: string): string =>
  path.replace(/[\\/][^\\/]*$/, "") || path;

/** The tooltip naming each server's legacy algorithms, one server a line. */
const legacyTitle = (servers: LegacyAlgorithms[]): string =>
  [
    "Connected with legacy SSH algorithms, because the server offers nothing newer:",
    ...servers.map(({ address, algorithms }) => `${address}: ${algorithms.join(", ")}`),
  ].join("\n");

function StatusBarBase() {
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
      <ForwardCenter />
      <TransferCenter />
      {tab && (
        <>
          {legacy.length > 0 && (
            <span className="status-item status-legacy" title={legacyTitle(legacy)}>
              <Icon name="warning" />
              Legacy SSH
            </span>
          )}
          {recording && (
            <button
              type="button"
              className="status-item status-recording"
              title={`Recording to ${recording} — click to open the folder`}
              onClick={() =>
                void api.openLocalPath(parentDir(recording)).catch(() => undefined)
              }
            >
              <Icon name="record" />
              REC
            </button>
          )}
          {isFileSession(tab.info.kind) ? (
            <span className="status-item">Dual-pane file transfer</span>
          ) : (
            <span className="status-item">
              Window {tab.rows}×{tab.cols}
            </span>
          )}
          <span className="status-item">{tab.info.protocol}</span>
        </>
      )}
      <span className="status-item">{stamp}</span>
    </div>
  );
}

// Memoised: the bar takes no props, so the app's re-renders skip it and it
// redraws only for the store slices and clock it reads itself.
export const StatusBar = memo(StatusBarBase);
