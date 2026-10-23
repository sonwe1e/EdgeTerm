import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { RELEASES_URL } from "./distribution";
import { errorText } from "./errorInfo";

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "manual" }
  | { phase: "error"; message: string };

/** This distribution publishes manual downloads, not a signed updater feed. */
export function useUpdater() {
  const [appVersion, setAppVersion] = useState("");
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });
  const requestId = useRef(0);

  useEffect(() => {
    let disposed = false;
    void getVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    }).catch(console.error);
    return () => {
      disposed = true;
      requestId.current += 1;
    };
  }, []);

  const checkForUpdates = useCallback(() => {
    requestId.current += 1;
    setState({ phase: "manual" });
  }, []);

  const dismiss = useCallback(() => {
    requestId.current += 1;
    setState({ phase: "idle" });
  }, []);

  const openDownloads = useCallback(async () => {
    const id = ++requestId.current;
    try {
      await openUrl(RELEASES_URL);
      if (id === requestId.current) setState({ phase: "idle" });
    } catch (error) {
      if (id === requestId.current) {
        setState({ phase: "error", message: errorText(error) });
      }
    }
  }, []);

  return { appVersion, state, checkForUpdates, dismiss, openDownloads };
}
