import { writeClipboardText } from "./api";
import { IS_MAC, IS_WINDOWS } from "./platform";

/**
 * Puts text the user asked for on the system clipboard. On macOS and Windows
 * the process writes it: WKWebView refuses a page write outside a user gesture
 * and does not count a selection's mouse-up as one (issue #63), while WebView2
 * gates the page write behind a permission prompt the app cannot raise again.
 * WebKitGTK lets the page write it (see `enable_clipboard_access`).
 */
export const writeSystemClipboard = (text: string): Promise<void> =>
  IS_MAC || IS_WINDOWS ? writeClipboardText(text) : navigator.clipboard.writeText(text);
