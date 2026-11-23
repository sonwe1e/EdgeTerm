import * as api from "./api";
import { useAgents } from "./agents/model";
import { errorInfo, errorText } from "./errorInfo";
import { beginFileEditorOpen, isFileEditorOpenCurrent, openFileEditor } from "./fileEditor";
import { beginGitOpen, isGitOpenCurrent, openGitWorkspace, pickGitFolder } from "./gitWorkspace";
import { fontStack } from "./fonts";
import { commandHistory } from "./history";
import { t } from "./i18n";
import { IS_WINDOWS } from "./platform";
import {
  beginConnectionAttempt,
  closeConnection,
  connectionAttemptVersion,
  hasConnectionWork,
  holdConnectionCleanup,
  invalidateConnectionAttempt,
  isBackendAttemptCurrent,
  isConnectionClosing,
  needsConnectionCleanup,
} from "./sessionConnectionLifecycle";
import { tabTitle, useStore, type HostKeyPrompt, type Tab } from "./store";
import type { TerminalController } from "./terminal";
import { clearPendingInput, takePendingInput } from "./pendingInput";
import { sendSessionInput } from "./sessionInput";
import { disposeController, getController, setController } from "./terminalRegistry";
import { parseQuickConnect, quickConnectLabel, quickConnectProfile } from "./quickConnect";
import { newSessionProfile } from "./sessionDefaults";
import { isFileSession, type SessionInfo, type SessionProfile } from "./types";
import { rememberWorkspaceDirectory } from "./workspaceDirectories";
import { createResizeCoalescer, type ResizeCoalescer } from "./resizeCoalescer";

/**
 * One resize coalescer per session, so a drag's per-frame grid reports reach
 * the backend as one call per interval; see `createResizeCoalescer`.
 */
const resizers = new Map<string, ResizeCoalescer>();

function coalescedResize(id: string): ResizeCoalescer {
  let resizer = resizers.get(id);
  if (!resizer) {
    resizer = createResizeCoalescer((cols, rows) => {
      void api.resizeSession(id, cols, rows).catch(() => undefined);
    });
    resizers.set(id, resizer);
  }
  return resizer;
}

/**
 * Line written into a terminal when its session ends, however it ended. Built
 * per call so it carries the interface language in force (see i18n.ts).
 */
export const sessionClosedNotice = (): string =>
  `\r\n\x1b[33m${t("terminal.sessionClosed")}\x1b[0m\r\n`;

export function newSessionId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function pendingSessionInfo(id: string, profile: SessionProfile): SessionInfo {
  const name = profile.name || profile.host || profile.portName || "session";

  let protocol: string;
  let address: string;
  if (profile.kind === "ssh") {
    protocol = "ssh";
    address = `${profile.host || "localhost"}:${profile.port ?? 22}`;
  } else if (profile.kind === "telnet") {
    protocol = "telnet";
    address = `${profile.host || "localhost"}:${profile.port ?? 23}`;
  } else if (profile.kind === "sftp") {
    protocol = "sftp";
    address = `${profile.host || "localhost"}:${profile.port ?? 22}`;
  } else if (profile.kind === "ftp") {
    protocol = "ftp";
    address = `${profile.host || "localhost"}:${profile.port ?? 21}`;
  } else if (profile.kind === "serial") {
    protocol = "serial";
    address = `${profile.portName || "-"}@${profile.baudRate ?? 115_200}`;
  } else {
    protocol = "shell";
    address = profile.shell || t("session.defaultShell");
  }

  return {
    id,
    profileId: profile.id || null,
    name,
    kind: profile.kind,
    protocol,
    address,
    color: profile.color ?? null,
    supportsRemoteFiles: profile.kind === "ssh" || isFileSession(profile.kind),
    // Known once the backend has opened the file.
    recording: null,
    // Known once the backend has connected.
    legacyAlgorithms: [],
    sharedConnection: false,
  };
}

/** Ignore cancelled owners while their handshake/cleanup is being drained. */
export function shouldApplySessionState(id: string): boolean {
  if (!useStore.getState().tabs.some((tab) => tab.info.id === id)) return false;
  return isBackendAttemptCurrent(id);
}

function sameConnectionIdentity(left: SessionProfile, right: SessionProfile): boolean {
  const port = (profile: SessionProfile) =>
    profile.port ?? (profile.kind === "ftp" ? 21 : profile.kind === "telnet" ? 23 : 22);
  return (
    left.kind === right.kind &&
    (left.host ?? "").trim().toLowerCase() === (right.host ?? "").trim().toLowerCase() &&
    port(left) === port(right) &&
    (left.username ?? "") === (right.username ?? "") &&
    (left.jumpProfileId ?? "") === (right.jumpProfileId ?? "")
  );
}

/**
 * The history bucket a session's commands belong to, so suggestions can
 * prefer commands seen on the same host. Resolved per call because the tab's
 * info is refined once the backend connects.
 */
function historyHost(id: string): string {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  return tab ? `${tab.info.protocol}:${tab.info.address}` : "";
}

/**
 * Returns the terminal for a session, creating it if needed. Wiring lives here
 * rather than in the React component so a terminal can exist before anything
 * renders.
 *
 * xterm and its addons are the largest thing the application loads and no
 * session needs them until one is opened, so they arrive with the first
 * terminal instead of with the window.
 */
export async function ensureController(id: string): Promise<TerminalController> {
  const existing = getController(id);
  if (existing) return existing;

  const { TerminalController } = await import("./terminal");
  // A second caller may have finished while this one waited for the module.
  const raced = getController(id);
  if (raced) return raced;

  const controller = new TerminalController(
    id,
    {
      // The funnel owns the two rules that are easy to break here: input typed
      // during the handshake is held rather than dropped, and synchronized
      // input reaches the other shells (see sessionInput.ts).
      onData: (data) => sendSessionInput(id, data),
      onBinary: (data) => void api.writeSessionBytes(id, data).catch(() => undefined),
      // Read at click time: a reconnect replaces the tab's state, and a link
      // in a dead session must not open a tunnel that has no transport.
      linkSession: () => {
        const tab = useStore.getState().tabs.find((item) => item.info.id === id);
        return tab ? { id, kind: tab.info.kind, connected: tab.state === "connected" } : null;
      },
      // Enter on the dead session reconnects it; the host key dialog owns
      // the next connection attempt while it is open.
      // A bell while the reader is in another tab badges this one; selecting
      // it acknowledges the badge.
      onBell: () => useStore.getState().noteTabBell(id),
      // The program's own window title (OSC 0/2): shown beside the tab's name,
      // never in place of it.
      onTitleChange: (title) => useStore.getState().noteTabTitle(id, title),
      onReconnect: () => {
        const store = useStore.getState();
        if (store.hostKeyPrompt?.sessionId === id) return;
        void reconnectSession(id);
      },
      // The Filer's follow mode consumes these: a shell that announced a new
      // directory moves an on-screen Filer to it, after the report burst
      // settles. Nothing here queries the server.
      onReportedCwd: (cwd) => {
        useStore.getState().terminalCwdReported(id, cwd.path, cwd.host);
        const tab = useStore.getState().tabs.find((item) => item.info.id === id);
        if (tab?.info.kind === "ssh") rememberWorkspaceDirectory(id, "terminal", cwd.path);
        else if (tab?.info.kind === "local")
          void isThisHost(cwd.host).then((local) => {
            if (local && getController(id)?.reportedCwd === cwd)
              rememberWorkspaceDirectory(id, "terminal", localPathFromUrlPath(cwd.path));
          });
      },
      // A Ctrl+clicked path from the output: open it in the built-in editor at
      // the printed line, through this session's own file system.
      onFileLink: (path, line, cwd) => void openTerminalFileLink(id, path, line, cwd),
      // An ssh:// link in the output: the same unsaved session the palette
      // starts from a typed target.
      onSshLink: (uri) => {
        const target = parseQuickConnect(uri);
        if (!target) return;
        // The palette offers this list back, so a host reached from a link is
        // one keystroke away next time, exactly like a typed one.
        useStore.getState().rememberQuickTarget(quickConnectLabel(target));
        void openSession(quickConnectProfile(target, newSessionProfile()));
      },
      onCommand: (command) => commandHistory.record(command, historyHost(id)),
      onAiSession: (tool) => {
        if (tool === null) {
          const activeController = getController(id);
          if (activeController) activeController.agentKeyPassthrough = false;
        }
        useAgents.setState((state) => ({ recognized: { ...state.recognized, [id]: tool } }));
      },
      onCommandState: (state, kind, exit) => {
        const store = useStore.getState();
        if (state === "running") store.markCommandStarted(id, kind);
        else if (state === "complete") {
          store.markCommandCompleted(id, kind);
          // Only a shell that announces its status (OSC 133 D) can say this;
          // a command whose status is unknown stays quiet.
          if (exit !== null && exit !== undefined && exit !== 0)
            store.setStatus(t("status.commandFailed", { code: exit }));
        } else store.clearCommandActivity(id);
      },
      suggest: (input) => commandHistory.suggest(input, historyHost(id)),
      forgetSuggestion: (command) =>
        void commandHistory
          .remove(command)
          .catch((error: unknown) =>
            useStore
              .getState()
              .setStatus(t("status.commandHistoryForgetFailed", { error: errorText(error) })),
          ),
      onResize: (cols, rows) => {
        useStore.getState().setSize(id, cols, rows);
        // A drag reports every frame; the PTY only needs the last size.
        coalescedResize(id).request(cols, rows);
      },
      onDispose: () => {
        resizers.get(id)?.cancel();
        resizers.delete(id);
      },
      onStatus: (message, error = false) => {
        const store = useStore.getState();
        store.setStatus(message);
        if (error) store.setError(message, id);
        else if (store.errorSessionId === id) store.setError(null);
      },
    },
    useStore.getState().bufferFontSize,
    useStore.getState().terminalScrollback,
    useStore.getState().theme,
    fontStack(
      "mono",
      useStore.getState().bufferFontFamily,
      useStore.getState().symbolFontFamilies,
      useStore.getState().systemMonoFamily,
    ),
  );
  controller.setSuggestions(useStore.getState().suggestionsEnabled);
  controller.setRightClickAction(useStore.getState().rightClickAction);
  controller.setPasteWarning(useStore.getState().pasteWarning);
  controller.setCopyOnSelect(useStore.getState().copyOnSelect);
  controller.setProgramClipboard(useStore.getState().programClipboard);
  // A program's first clipboard write of the session asks (OSC 52); a later
  // one replaces the text of a prompt still open.
  controller.onConfirmClipboardWrite((text) =>
    useStore.getState().setClipboardPrompt({ sessionId: id, text }),
  );
  // A paste that would submit several commands stops here and asks; App
  // renders the dialog and pastes it once the user agrees.
  controller.onConfirmPaste((text) => useStore.getState().setPastePrompt({ sessionId: id, text }));
  // The lazy import can outlive a tab closed during startup. Its callers
  // already check their own liveness; do not retain an orphan in the registry.
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  if (tab) {
    controller.setLocked(
      isConnectionClosing(id) || tab.state === "closed" || tab.state === "error",
    );
    setController(id, controller);
  } else controller.dispose();
  return controller;
}

/**
 * Opens a session. The id is minted here and the terminal is created *before*
 * the backend connects, so output emitted during login (an SSH banner, a
 * shell's first prompt) always has somewhere to land.
 *
 * `reuseSessionId` puts the new session on that session's SSH connection
 * instead of dialling one of its own; see `duplicateSshChannel`.
 */
/**
 * A startup command waits for the prompt. The backend reports "connected" as
 * soon as the channel is up, which is before a shell has printed anything;
 * a line sent then would land inside the banner. The delay is short and the
 * timer re-checks the session, so a tab closed in between sends nothing.
 */
const STARTUP_DELAY_MS = 400;
const startupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleStartupCommand(id: string, command: string): void {
  const previous = startupTimers.get(id);
  if (previous !== undefined) clearTimeout(previous);
  startupTimers.set(
    id,
    setTimeout(() => {
      startupTimers.delete(id);
      const tab = useStore.getState().tabs.find((item) => item.info.id === id);
      if (!tab || tab.state !== "connected") return;
      void api.writeSession(id, command + "\r").catch((error: unknown) => {
        // The reader set this line so the session starts in the right place; a
        // write that never reached the shell is worth saying out loud.
        useStore.getState().setStatus(t("session.startupFailed", { error: errorText(error) }));
      });
    }, STARTUP_DELAY_MS),
  );
}

export async function openSession(
  profile: SessionProfile,
  reuseSessionId?: string,
  attemptTabId?: string,
): Promise<string | null> {
  const id = attemptTabId ?? newSessionId();
  if (isConnectionClosing(id)) return null;
  const existing = useStore.getState().tabs.find((tab) => tab.info.id === id);
  if (existing) {
    if (existing.state !== "error" && existing.state !== "closed") return null;
    if (isFileSession(profile.kind)) disposeController(id);
    useStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.info.id === id
          ? { ...tab, info: pendingSessionInfo(id, profile), profile, state: "connecting" as const }
          : tab,
      ),
    }));
    useStore.getState().setActive(id);
  } else {
    useStore.getState().addTab(pendingSessionInfo(id, profile), profile, "connecting");
  }
  // Cancellation can happen during the first lazy terminal import, before
  // connectSession has a backend attempt to retire. Reserve its intent now.
  invalidateConnectionAttempt(id);
  const version = connectionAttemptVersion(id);
  if (!isFileSession(profile.kind)) await ensureController(id);
  const current = useStore.getState().tabs.find((tab) => tab.info.id === id);
  if (
    connectionAttemptVersion(id) !== version ||
    isConnectionClosing(id) ||
    current?.state !== "connecting"
  ) {
    return null;
  }
  return connectSession(id, profile, reuseSessionId);
}

/**
 * Reopen Closed Tab: the newest closed session comes back on a fresh
 * connection and a fresh session id. Reusing the old id would collide with
 * the tab's retired controller, and nothing about the closed session's
 * transport is worth keeping.
 */
export async function reopenClosedTab(): Promise<string | null> {
  const closed = useStore.getState().takeClosedTab();
  if (!closed) {
    useStore.getState().setStatus(t("status.nothingToReopen"));
    return null;
  }
  return openSession(closed.profile);
}

/**
 * Duplicate SSH Channel (a tab's context menu, WindTerm's name for it):
 * another shell on the connection this SSH tab already runs on, in the same
 * pane. Nothing is logged in to again — the password, passphrase, one-time
 * code or push was spent on the connection, not on the tab, so a server
 * behind MFA takes one code however many channels are opened (issues #63,
 * #73). The tabs sharing a connection go down together if it does. Only an
 * explicit choice. Other new tabs use the automatic reuse preference.
 */
export async function duplicateSshChannel(id: string): Promise<string | null> {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (!tab || !canDuplicateSshChannel(tab)) return null;
  // The duplicate belongs beside its original, which need not be in the pane
  // the user last worked in; openSession opens into the active one.
  store.setActivePane(tab.paneId);
  return openSession(tab.profile, tab.info.id);
}

/** Whether `tab` has a live SSH connection to open another channel on. */
export const canDuplicateSshChannel = (tab: Tab): boolean =>
  tab.info.kind === "ssh" && tab.state === "connected";

/**
 * Split Right / Split Down: opens another session of the tab's profile in
 * a new pane beside the tab's own — what a terminal's split means (iTerm2,
 * Windows Terminal, VS Code's terminal), since one session cannot show in
 * two places. The profile is the tab's own copy, secrets included, so a
 * saved password or passphrase is not asked for again.
 */
export async function splitSession(id: string, side: "right" | "down"): Promise<string | null> {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (!tab) return null;
  // The new pane becomes the active one, which is where openSession opens.
  store.splitPane(tab.paneId, side);
  return openSession(tab.profile);
}

/**
 * Disconnects a tab's session but keeps the tab, its terminal and its
 * scrollback, so `reconnectSession` can bring it back in place. The backend
 * does not echo a "closed" state for a close it was asked for (see
 * `emit_state` in session/mod.rs), so the tab is marked here.
 */
export async function disconnectSession(id: string): Promise<void> {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  if (!tab || isConnectionClosing(id)) return;

  // A connect that has not settled is cancellable: mark the attempt so its
  // reply is ignored, close whatever the backend already created, and park
  // the tab on the same "closed" state a normal disconnect leaves it in.
  if (tab.state === "connecting") {
    invalidateConnectionAttempt(id);
    const store = useStore.getState();
    for (const prompt of store.authPrompts) {
      if (prompt.sessionId !== id) continue;
      void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
      store.clearAuthPrompt(prompt.id);
    }
    const message = t("status.connectionCancelled");
    store.applyState(id, "closed", message);
    store.setStatus(message);
    getController(id)?.writeText(`\r\n\x1b[33m${message}\x1b[0m\r\n`);
    const closing = closeConnection(id).catch(() => undefined);
    holdConnectionCleanup(id, closing);
    await closing;
    return;
  }

  // The backend reports "connected" as soon as the session task starts,
  // which can land before open_session's own reply. Closing in that window
  // would let the late reply mark the tab connected again over a session
  // that is already gone, so wait for the connect to settle first.
  if (tab.state !== "connected" || hasConnectionWork(id)) return;

  invalidateConnectionAttempt(id);
  let failure: string | null = null;
  const closing = closeConnection(id).catch((e) => {
    failure = errorText(e);
  });
  holdConnectionCleanup(id, closing);
  await closing;

  const store = useStore.getState();
  const current = store.tabs.find((item) => item.info.id === id);
  // The tab may have been closed meanwhile, or the session may have ended on
  // its own while the close was in flight; either way there is nothing left
  // to mark.
  if (!current || current.state !== "connected") return;

  store.applyState(id, "closed", failure ?? t("status.disconnectedReason"));
  // The backend stays silent for a close it was asked for, so echo the same
  // notice into the terminal that a peer-initiated close gets (see App.tsx).
  getController(id)?.writeText(sessionClosedNotice());
  if (failure) store.setError(failure, id);
  else store.setStatus(t("status.disconnected", { name: tabTitle(current) }));
}

/**
 * Reconnects a tab whose session ended — by `disconnectSession`, a failed
 * connection, or the peer going away — reusing its terminal so the earlier
 * output stays in the scrollback. Resolves like `openSession`.
 */
export function reconnectSession(id: string): Promise<string | null> {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (!tab || isConnectionClosing(id) || (tab.state !== "closed" && tab.state !== "error")) {
    return Promise.resolve(null);
  }
  // The tab's copy is the profile as it was when the session opened. Editing
  // the saved session does not rewrite that copy (only the public-key setup
  // does), so reconnecting from it would dial the old host with the old
  // credentials while the tree shows the new ones. A tab-only secret belongs
  // to its original endpoint/account and must not follow a profile to another.
  const saved = tab.profile.id
    ? store.profiles.find((profile) => profile.id === tab.profile.id)
    : undefined;
  const sameAuthentication =
    saved &&
    sameConnectionIdentity(saved, tab.profile) &&
    (saved.auth ?? "password") === (tab.profile.auth ?? "password");
  const sameKey =
    sameAuthentication && (saved?.privateKeyPath ?? "") === (tab.profile.privateKeyPath ?? "");
  const profile = saved
    ? {
        ...saved,
        password: saved.password ?? (sameAuthentication ? tab.profile.password : undefined),
        passphrase: saved.passphrase ?? (sameKey ? tab.profile.passphrase : undefined),
      }
    : tab.profile;
  return connectSession(id, profile);
}

/**
 * The one-button behaviour of a tab's power toggle: a live session is
 * disconnected, an ended one is reconnected, and a session still connecting
 * is left alone.
 *
 * Keyboard focus goes back to the terminal: the Session panel's power button
 * would otherwise keep it (and drop it to the body once it disables itself
 * while connecting), so the reconnected shell needed another click before it
 * took keys (issue #67).
 */
export function toggleSessionConnection(id: string): void {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  if (!tab) return;
  getController(id)?.focus();
  if (tab.state === "connected" || tab.state === "connecting") {
    void disconnectSession(id);
  } else {
    void reconnectSession(id);
  }
}

/**
 * Connects the backend session behind an existing tab. Resolves to the tab id
 * once the tab has something to show — a live session, or a changed host key
 * waiting on the user — and to null when the connection failed or the tab
 * was closed meanwhile.
 */
export async function connectSession(
  id: string,
  profile: SessionProfile,
  reuseSessionId?: string,
): Promise<string | null> {
  const store = useStore.getState();
  const pending = store.tabs.find((item) => item.info.id === id);
  if (isConnectionClosing(id)) return null;
  if (!pending) {
    disposeController(id);
    return null;
  }
  const label = tabTitle(pending);

  store.setStatus(t("status.connecting", { name: label }));
  store.setError(null);
  store.applyState(id, "connecting");

  const attempt = beginConnectionAttempt(id);
  const current = () =>
    attempt.current() && useStore.getState().tabs.some((tab) => tab.info.id === id);
  try {
    // The backend owns sessions by id, not frontend attempt. A cancelled
    // handshake must finish and be closed before a retry may claim that id.
    if (attempt.previous) await attempt.previous;
    if (!current()) return null;
    if (needsConnectionCleanup(id)) {
      await closeConnection(id);
      if (!current()) return null;
    }
    let connectionProfile = profile;
    const cwd = sameConnectionIdentity(pending.profile, profile)
      ? pending.directories?.terminal
      : undefined;
    if (cwd && (profile.kind === "local" || profile.kind === "ssh")) {
      let startAt = cwd;
      if (profile.kind === "local") {
        // A removed directory should not turn a remembered local tab into a
        // permanently failed shell. Listing also validates the path as a directory.
        try {
          await api.localList(cwd);
        } catch {
          startAt = await api.localHome();
        }
      }
      connectionProfile = { ...profile, cwd: startAt };
    }
    if (!current()) return null;
    // Only the current owner may change the decoder before its banner.
    getController(id)?.setEncoding(profile.encoding);
    getController(id)?.setBackspace(profile.backspace);
    attempt.claimBackend();
    // A fresh shell may never set a window title; the previous program's one
    // ("vim notes.txt") would otherwise sit beside a session that no longer
    // runs it. Clearing before the new handshake means the bar only ever shows
    // a title this shell reported.
    useStore.getState().noteTabTitle(id, "");
    // The controller exists before the backend is asked to connect (see
    // openSession), so the output channel handed over here already has a
    // terminal to land its bytes on.
    const outcome = await api.openSession(
      connectionProfile,
      id,
      (bytes, consumed) => {
        if (!current()) {
          consumed();
          return;
        }
        const controller = getController(id);
        if (controller) controller.write(bytes, consumed);
        else consumed();
      },
      reuseSessionId,
      useStore.getState().sshAutoReuse,
    );

    // No later handshake can start until this cleanup has completed. Closing
    // by id here therefore cannot accidentally close a successful newer retry.
    if (!current()) {
      if (outcome.status === "connected") {
        await closeConnection(id).catch(() => undefined);
      }
      if (!useStore.getState().tabs.some((tab) => tab.info.id === id)) disposeController(id);
      return null;
    }

    // The user may close the optimistic tab while SSH is still negotiating.
    // In that case close the newly-created backend session immediately.
    const connectedStore = useStore.getState();
    const tab = connectedStore.tabs.find((item) => item.info.id === id);
    if (!tab) {
      if (outcome.status === "connected") {
        await closeConnection(id).catch(() => undefined);
      }
      disposeController(id);
      return null;
    }

    if (outcome.status === "hostKeyChanged") {
      // Nothing was opened. Park the tab on the refusal and let the user
      // decide in the host key dialog, which reconnects on accept.
      const { change } = outcome;
      failSession(id, change.message, false);
      connectedStore.setHostKeyPrompt({ sessionId: id, profile, change });
      return id;
    }

    const { info } = outcome;
    connectedStore.updateTabInfo(id, info);
    connectedStore.updateTabProfile(id, profile);
    connectedStore.applyState(id, "connected");
    // A profile the reader saved is one they keep coming back to; remembering
    // it here is what lets the palette mark it later. An unsaved quick-connect
    // target has no id and is remembered by its label instead.
    if (profile.id) connectedStore.rememberRecentProfile(profile.id);
    const name = tabTitle({ ...tab, info });
    connectedStore.setStatus(
      info.sharedConnection
        ? t("status.connectedShared", { name })
        : t("status.connected", { name }),
    );

    // Whatever was typed while the handshake ran goes out now that there is a
    // session to receive it.
    const typedWhileConnecting = takePendingInput(id);
    if (typedWhileConnecting) {
      void api.writeSession(id, typedWhileConnecting).catch(() => undefined);
    }

    // The profile's own first command, after whatever the reader already typed:
    // a login script is a starting point, not a queue jumper.
    const startupCommand = useStore.getState().startupCommands[profile.id];
    if (startupCommand && !typedWhileConnecting && (info.kind === "ssh" || info.kind === "local")) {
      scheduleStartupCommand(id, startupCommand);
    }

    // The pane was fitted while the backend was still connecting, so its
    // first resize command could not be delivered. Re-send the current size.
    const size = useStore.getState().tabSizes[id];
    if (!isFileSession(info.kind) && size) {
      // This send has to be the last word: drop a grid still queued from the
      // panes' own reports during the connect, or it could land after this.
      resizers.get(id)?.cancel();
      void api.resizeSession(id, size.cols, size.rows).catch(() => undefined);
    }
    return id;
  } catch (e) {
    if (!current()) {
      if (!useStore.getState().tabs.some((tab) => tab.info.id === id)) disposeController(id);
      return null;
    }
    const message = errorText(e);
    // The attempt is over and nothing will write these bytes: forgetting them
    // is better than replaying them into a later, unrelated session.
    clearPendingInput(id);
    if (useStore.getState().tabs.some((tab) => tab.info.id === id)) {
      // The failing call carries the diagnostics request id; keeping it lets
      // the bar's copy button hand over a report that can be traced in the log.
      failSession(id, message, true, errorInfo(e).requestId);
    } else {
      disposeController(id);
    }
    return null;
  } finally {
    attempt.finish();
  }
}

/**
 * Marks a tab's connection as failed and echoes why into its terminal. The
 * echo offers Enter-to-reconnect unless another surface (the host key
 * dialog) owns the next attempt.
 */
function failSession(id: string, message: string, hint = true, requestId?: string): void {
  const store = useStore.getState();
  store.applyState(id, "error", message);
  store.setError(message, id, requestId);
  store.setStatus(t("status.failed", { message }));
  const terminalMessage = message.replace(/[\x00-\x1f\x7f]/g, " ");
  const failed = t("terminal.connectionFailed", { message: terminalMessage });
  getController(id)?.writeText(
    `\r\n\x1b[31m${failed}${hint ? t("terminal.pressEnterToReconnect") : ""}]\x1b[0m\r\n`,
  );
}

/**
 * Accepts the key a host now presents — replacing every known_hosts entry for
 * it — and reconnects the tab that was refused. Rejects when known_hosts could
 * not be updated; a failure of the reconnect itself shows on the tab.
 */
export async function acceptHostKey(prompt: HostKeyPrompt): Promise<void> {
  await api.acceptHostKey(prompt.change);
  const store = useStore.getState();
  store.setHostKeyPrompt(null);
  if (!store.tabs.some((tab) => tab.info.id === prompt.sessionId)) return;
  getController(prompt.sessionId)?.writeText(
    `\r\n${t("terminal.acceptedHostKey", {
      fingerprint: prompt.change.fingerprint,
    })}\r\n`,
  );
  void connectSession(prompt.sessionId, prompt.profile);
}

// --- Filer: reveal the shell's working directory ----------------------------

let localHostname: Promise<string> | null = null;

function firstLabel(host: string): string {
  return host.toLowerCase().split(".")[0];
}

/**
 * Whether an OSC 7 host names this machine. A remote shell the user ssh'd
 * into by hand from a local tab reports its own host, and that directory
 * must not be looked for in the local Filer.
 */
async function isThisHost(host: string): Promise<boolean> {
  if (host === "" || host === "localhost") return true;
  localHostname ??= api.localHostname().catch(() => "");
  const mine = await localHostname;
  return mine !== "" && firstLabel(host) === firstLabel(mine);
}

/** `/C:/Users/me` from a Windows shell's OSC 7 URL → `C:\Users\me`. */
function localPathFromUrlPath(path: string): string {
  if (!IS_WINDOWS) return path;
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  if (!drive) return path;
  return `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}`;
}

/**
 * Where the tab's shell is right now. An SSH shell's own OSC report wins
 * (exact even inside sudo or a nested shell), then the server is asked
 * (`session_cwd`; Linux hosts). A local shell is asked through the OS
 * first — exact, and needing no shell setup — with its OSC report as the
 * fallback where the OS cannot be asked (Windows).
 */
export async function shellCwd(tab: Tab): Promise<string> {
  const id = tab.info.id;
  const reported = getController(id)?.reportedCwd ?? null;
  if (tab.info.kind === "ssh") {
    if (reported) return reported.path;
    return api.sessionCwd(id);
  }
  try {
    return await api.sessionCwd(id);
  } catch (error) {
    if (reported && (await isThisHost(reported.host))) {
      return localPathFromUrlPath(reported.path);
    }
    throw error;
  }
}

export async function openSessionGit(id?: string): Promise<void> {
  const request = beginGitOpen();
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  try {
    if (tab?.state === "connected" && (tab.info.kind === "local" || tab.info.kind === "ssh")) {
      try {
        const directory = await shellCwd(tab);
        openGitWorkspace(
          {
            directory,
            sessionId: tab.info.kind === "ssh" ? tab.info.id : null,
            label: tab.info.kind === "ssh" ? tabTitle(tab) : null,
          },
          request,
        );
        return;
      } catch (error) {
        // A missing remote CWD must not silently open a different host.
        if (tab.info.kind === "ssh") {
          if (isGitOpenCurrent(request))
            useStore.getState().setError(t("git.openFromFiler", { error: errorText(error) }), id);
          return;
        }
      }
    }
    if (!isGitOpenCurrent(request)) return;
    if (tab?.info.kind === "ssh") {
      useStore.getState().setError(t("status.filerNotConnected"), id);
      return;
    }
    await pickGitFolder(
      request,
      tab?.info.kind === "local" ? tab.directories?.terminal : undefined,
    );
  } catch (error) {
    if (isGitOpenCurrent(request)) useStore.getState().setError(errorText(error), id);
  }
}

/** Joins a relative path printed in the terminal onto a directory. */
function joinPrintedPath(dir: string, path: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${path}`;
}

/**
 * Opens a file path printed by a command in the built-in editor, at the line
 * the output named. The path belongs to the directory the shell was in when
 * that line was printed; when no report covered it (or it is stale), the
 * session's current directory is tried next, so a click still opens the file
 * the user meant instead of asking a question first. The editor's own read is
 * the existence check — nothing is read until the click.
 */
async function openTerminalFileLink(
  sessionId: string,
  path: string,
  line: number | undefined,
  cwd: string | null,
): Promise<void> {
  const request = beginFileEditorOpen();
  if (request === null) return;
  const candidates: string[] = [];
  if (path.startsWith("/")) {
    candidates.push(path);
  } else {
    if (cwd) candidates.push(joinPrintedPath(cwd, path));
    const tab = useStore.getState().tabs.find((item) => item.info.id === sessionId);
    if (tab) {
      try {
        candidates.push(joinPrintedPath(await shellCwd(tab), path));
      } catch {
        // A disconnected session or a shell that cannot be asked; the
        // attributed directory above is still worth a try.
      }
    }
  }
  if (!isFileEditorOpenCurrent(request)) return;
  for (const candidate of [...new Set(candidates)]) {
    const opened = await openFileEditor(sessionId, candidate, { line, request });
    if (opened === null) return;
    if (opened) {
      // An earlier candidate may have failed and left its reason on the status
      // line; opening the file is the outcome the user needs to see.
      useStore.getState().setStatus(t("status.fileLinkOpened", { path: candidate }));
      return;
    }
  }
  if (candidates.length === 0) {
    useStore.getState().setStatus(t("status.linkNoDirectory", { path }));
  }
}

/**
 * Points the Filer at the directory the session's shell is in — ⌘J /
 * Ctrl+Shift+J, the terminal's context menu and the Filer's locate button
 * all land here. One query per request; nothing follows the shell around.
 */
export async function revealCwdInFiler(id: string): Promise<void> {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (!tab) return;
  if (tab.info.kind !== "local" && tab.info.kind !== "ssh") {
    store.setStatus(t("status.filerOnlyShellSsh"));
    return;
  }
  if (tab.state !== "connected") {
    store.setStatus(t("status.filerNotConnected"));
    return;
  }
  try {
    const path = await shellCwd(tab);
    useStore.getState().revealInFiler(id, path);
    useStore.getState().setStatus(t("status.filerPath", { path }));
  } catch (error) {
    useStore.getState().setError(t("status.filerError", { error: errorText(error) }), id);
  }
}
