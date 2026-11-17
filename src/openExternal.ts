import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "./api";
import { errorText } from "./errorInfo";
import { t, type MessageKey } from "./i18n";
import { useStore } from "./store";

/**
 * Runs something the user explicitly asked for — opening a link, revealing a
 * folder — and turns a failure into the status bar's error, which is visible,
 * copyable and stays until dismissed.
 *
 * These used to log to the console or drop the rejection: a click that did
 * nothing and said nothing reads as "the app is broken", and the error text is
 * what the user would need to report it.
 */
async function reportFailure(action: () => Promise<unknown>, key: MessageKey, path: string) {
  try {
    await action();
  } catch (error) {
    useStore.getState().setError(t(key, { path, error: errorText(error) }));
  }
}

/** Opens a link; see `reportFailure` for what a failure does. */
export const openExternalLink = (url: string): Promise<void> =>
  reportFailure(() => openUrl(url), "status.linkOpenFailed", url);

/** Reveals a path in the system file manager; a failure is reported the same way. */
export const revealLocalPath = (path: string): Promise<void> =>
  reportFailure(() => api.openLocalPath(path), "status.folderOpenFailed", path);
