import { invoke } from "@tauri-apps/api/core";

/**
 * One live report preview: a read-only loopback HTTP server that serves one
 * remote HTML report and the resources beside it, read over the session's own
 * SSH connection. `url` is the address to open in the system browser.
 */
export interface RemotePreview {
  id: string;
  /** `http://127.0.0.1:<port>/<token>/<report.html>` — open this in the browser. */
  url: string;
  /** The remote directory the preview may read; nothing outside it loads. */
  root: string;
  port: number;
}

/**
 * Starts a preview of the remote HTML report at `path` — the report file the
 * Filer's context menu was opened on — and returns the URL to hand to the
 * system browser. The report's directory becomes the only tree the preview
 * reads, so a relative `./charts.js` or `./data.json` beside it loads; an
 * absolute reference such as `/assets/loss.png` names the server's root and
 * is not served in this first version. Opening the same report again reuses
 * the running preview instead of binding a second port.
 */
export const startPreview = (sessionId: string, path: string): Promise<RemotePreview> =>
  invoke<RemotePreview>("preview_start", { sessionId, path });

/**
 * Stops one preview. Resolves once its loopback port has been released; a
 * session close stops the previews that session owned.
 */
export const stopPreview = (id: string): Promise<void> => invoke<void>("preview_stop", { id });

/** The previews still serving, for a panel that lists or reopens them. */
export const listPreviews = (): Promise<RemotePreview[]> => invoke<RemotePreview[]>("preview_list");
