import { openUrl } from "@tauri-apps/plugin-opener";
import { errorText } from "./errorInfo";
import { t } from "./i18n";
import { startPreview, stopPreview, type RemotePreview } from "./previewClient";
import { useStore } from "./store";

/**
 * The Filer's "preview this report in the browser" action. Starting a preview
 * binds a loopback HTTP server that reads the report's directory over that
 * session's own SSH connection, so relative scripts, data and images beside
 * the report load in a real browser; the browser then refreshes against the
 * remote files, which is what makes a training run's report update live.
 *
 * The map below is this window's view of the previews it started: the Rust
 * side owns the servers, and a preview the session closed is gone from there
 * too, so stopping one that no longer exists reports the error rather than
 * pretending.
 */
const running = new Map<string, RemotePreview>();

const keyOf = (sessionId: string, path: string): string => `${sessionId}\u0000${path}`;

/** Whether this exact report already has a preview this window started. */
export function isPreviewRunning(sessionId: string, path: string): boolean {
  return running.has(keyOf(sessionId, path));
}

/** Opens (or reuses) one report's preview in the system browser. */
export async function previewReport(sessionId: string, path: string): Promise<void> {
  useStore.getState().setStatus(t("status.previewStarting", { path }));
  try {
    const preview = await startPreview(sessionId, path);
    running.set(keyOf(sessionId, path), preview);
    await openUrl(preview.url);
    useStore.getState().setStatus(t("status.previewOpened", { url: preview.url }));
  } catch (error) {
    useStore.getState().setError(t("status.previewFailed", { error: errorText(error) }), sessionId);
  }
}

/**
 * Stops one report's preview and releases its loopback port. Only a preview
 * this window started is known here, and the Filer offers the entry only for
 * those, so a missing record means there is nothing to stop.
 */
export async function stopReportPreview(sessionId: string, path: string): Promise<void> {
  const key = keyOf(sessionId, path);
  const entry = running.get(key);
  if (!entry) return;
  try {
    await stopPreview(entry.id);
    running.delete(key);
    useStore.getState().setStatus(t("status.previewStopped"));
  } catch (error) {
    useStore.getState().setError(t("status.previewFailed", { error: errorText(error) }), sessionId);
  }
}

/** Drops this window's records for a session that is closing. */
export function forgetSessionPreviews(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of [...running.keys()]) if (key.startsWith(prefix)) running.delete(key);
}
