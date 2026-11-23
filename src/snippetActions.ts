import { broadcastTargets } from "./broadcast";
import { t } from "./i18n";
import { sendSessionInput } from "./sessionInput";
import { snippetBytes, type Snippet } from "./snippets";
import { useStore } from "./store";
import { isFileSession } from "./types";

/**
 * Sends a saved command to the active shell. It goes through the same funnel
 * as typing, so synchronized input applies unchanged: a snippet sent while
 * broadcasting reaches the same shells a typed command would.
 *
 * Refused (with the reason in the status bar) when there is no live shell: a
 * file browser has no command line to run it on.
 */
export function sendSnippet(snippet: Snippet): boolean {
  if (!sendCommandText(snippet.command)) return false;
  const state = useStore.getState();
  // With synchronized input on, the same line went to every checked shell.
  // Saying only "Sent" hides how far it went — which is the one thing a
  // reader sending to several hosts needs to know.
  const others =
    state.broadcastInput && state.activeId
      ? broadcastTargets(
          state.tabs,
          state.activeId,
          state.broadcastExcluded,
          state.broadcastExcludedGroups,
        ).length
      : 0;
  state.setStatus(
    others > 0
      ? t("snippets.sentToMany", { name: snippet.name, count: others + 1 })
      : t("snippets.sent", { name: snippet.name }),
  );
  return true;
}

/**
 * Writes one command line to the active shell through the same funnel, and
 * says why when there is no shell to write to. No "Sent:" line: a command the
 * reader just picked out of their own history is already on the screen.
 */
export function sendCommandText(command: string): boolean {
  const state = useStore.getState();
  const tab = state.tabs.find((item) => item.info.id === state.activeId);
  if (!tab || tab.state !== "connected" || isFileSession(tab.info.kind)) {
    state.setStatus(t("snippets.needsShell"));
    return false;
  }
  sendSessionInput(tab.info.id, snippetBytes(command));
  return true;
}
/**
 * The prompt that fills a template in lives with the dialog that owns it. A
 * surface that does not own dialogs (the terminal's context menu) hands the
 * snippet over here, and the registered runner decides whether to ask first.
 */
let registeredRunner: ((snippet: Snippet) => void) | null = null;

export function registerSnippetRunner(runner: ((snippet: Snippet) => void) | null): void {
  registeredRunner = runner;
}

export function requestSnippetRun(snippet: Snippet): void {
  (registeredRunner ?? sendSnippet)(snippet);
}
/**
 * Saving the last command opens the same name prompt the palette uses. The
 * prompt belongs to the saved-command feature, so a surface without dialogs
 * asks for it here instead of growing its own.
 */
let registeredSaver: (() => void) | null = null;

export function registerSnippetSaver(saver: (() => void) | null): void {
  registeredSaver = saver;
}

/** No saver registered means no surface can ask; doing nothing is honest. */
export function requestSnippetSave(): void {
  registeredSaver?.();
}
/**
 * Opening the manager from a surface that only offers commands: the terminal's
 * menu can list a few saved commands, but editing them belongs to the dialog.
 */
let registeredOpener: (() => void) | null = null;

export function registerSnippetOpener(opener: (() => void) | null): void {
  registeredOpener = opener;
}

export function requestSnippetsOpen(): void {
  registeredOpener?.();
}
