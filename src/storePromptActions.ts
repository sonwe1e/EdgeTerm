import type { StateCreator } from "zustand";
import * as api from "./api";
import {
  type CwdReport,
  type FollowDestination,
  createFollowQueue,
  followDestination,
  followMode,
  pauseFollowing,
  startFollowing,
  stopFollowing,
} from "./filerFollow";
import { t } from "./i18n";
import { IS_WINDOWS } from "./platform";
import { AppStore } from "./storeTypes";
import { getController } from "./terminalRegistry";

/** A directory the Filer was told to follow, and where the answer came from. */
interface FollowSync {
  path: string;
  /** True when `sessionCwd` answered because the shell never reported one. */
  fromQuery: boolean;
}

export const createPromptActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "bumpSenderLibrary"
    | "setStatus"
    | "setError"
    | "addAuthPrompt"
    | "clearAuthPrompt"
    | "setHostKeyPrompt"
    | "setSshConfigImport"
    | "revealInFiler"
    | "startFilerFollow"
    | "stopFilerFollow"
    | "pauseFilerFollow"
    | "terminalCwdReported"
    | "resolveFilerFollow"
  >
> = (set, get) => {
  /**
   * This machine's name, asked once: a local shell's OSC report carries the
   * host it runs on, and that is how a hand-typed `ssh` elsewhere is told
   * apart from this machine's own directory. It cannot change while the window
   * runs. The reveal path in actions.ts keeps its own copy.
   */
  let hostname: Promise<string> | null = null;
  const thisHostname = (): Promise<string> => (hostname ??= api.localHostname().catch(() => ""));

  /** The tab that owns the id, when it is a connected shell that can be followed. */
  const followableTab = (sessionId: string) => {
    const tab = get().tabs.find((item) => item.info.id === sessionId);
    if (!tab || tab.state !== "connected") return null;
    return tab.info.kind === "local" || tab.info.kind === "ssh" ? tab : null;
  };

  /** The Filer is on screen and shows this session: the only one it follows. */
  const filerShows = (sessionId: string): boolean => {
    const state = get();
    return state.panels.filer && state.activeId === sessionId;
  };

  /**
   * Points the Filer at a directory. The token is the one `revealInFiler`
   * hands out: a repeat request for the path already shown is still a request
   * the panel has to act on.
   */
  const showDirectory = (sessionId: string, path: string): void => {
    const token = (get().filerTarget?.token ?? 0) + 1;
    set({ filerTarget: { sessionId, path, token } });
  };

  /**
   * The directory a report leads to, pausing a follow that crossed hosts. A
   * local shell that moved to another machine through a hand-typed ssh reports
   * that machine's paths, and this Filer cannot show them; it says so instead
   * of guessing. An SSH session's report always names its own server, which is
   * the one the Filer is browsing.
   */
  const destinationOf = async (
    sessionId: string,
    report: CwdReport | null,
  ): Promise<FollowDestination | null> => {
    const tab = followableTab(sessionId);
    if (!tab) return null;
    const local = tab.info.kind === "local";
    const destination = followDestination(report, {
      local,
      hostname: local ? await thisHostname() : "",
      windows: IS_WINDOWS,
    });
    if (destination.kind === "foreign") {
      set({
        filerFollow: pauseFollowing(get().filerFollow, sessionId),
        status: t("status.followForeignHost"),
      });
    }
    return destination;
  };

  /**
   * The session's directory from the terminal's own latest report — the one
   * `shellCwd` in actions.ts prefers. Only a shell that never reported one
   * falls back to the backend: a one-shot `session_cwd` query on this path,
   * never a poll, and the Filer can then say that later `cd`s will not follow.
   */
  const resolveFollow = async (sessionId: string): Promise<FollowSync | null> => {
    const tab = followableTab(sessionId);
    if (!tab) return null;
    const reported = getController(sessionId)?.reportedCwd ?? null;
    const destination = await destinationOf(sessionId, reported);
    if (destination === null) return null;
    if (destination.kind === "path") return { path: destination.path, fromQuery: false };
    // "foreign" paused the follow and said so; nothing to show.
    if (destination.kind === "foreign") return null;
    try {
      return { path: await api.sessionCwd(sessionId), fromQuery: true };
    } catch {
      // Windows local shells have no way to be asked; see `shellCwd`.
      return null;
    }
  };

  /**
   * Moves the Filer to a report. Everything is re-read here rather than at
   * arrival: the timer, and then the host-name round trip, give the user time
   * to pause, stop, switch sessions or close the panel.
   */
  const applyReport = async (sessionId: string, report: CwdReport): Promise<void> => {
    if (!filerShows(sessionId) || followMode(get().filerFollow, sessionId) !== "following") return;
    const destination = await destinationOf(sessionId, report);
    if (destination === null || destination.kind !== "path") return;
    if (!filerShows(sessionId) || followMode(get().filerFollow, sessionId) !== "following") return;
    showDirectory(sessionId, destination.path);
  };

  /**
   * One timer per session for the trailing report. The flush runs after the
   * delay, so consecutive `cd`s move the Filer once, to the last directory.
   */
  const reports = createFollowQueue((sessionId, report) => void applyReport(sessionId, report));

  return {
    bumpSenderLibrary() {
      set({ senderLibraryVersion: get().senderLibraryVersion + 1 });
    },

    setStatus(status) {
      set({ status });
    },

    setError(error, sessionId) {
      set({ error, errorSessionId: error ? (sessionId ?? null) : null });
    },

    addAuthPrompt(prompt) {
      set({ authPrompts: [...get().authPrompts, prompt] });
    },

    clearAuthPrompt(id) {
      set({
        authPrompts: get().authPrompts.filter((prompt) => prompt.id !== id),
      });
    },

    setHostKeyPrompt(prompt) {
      set({ hostKeyPrompt: prompt });
    },

    setSshConfigImport(preview) {
      set({ sshConfigImport: preview });
    },

    revealInFiler(sessionId, path) {
      const token = (get().filerTarget?.token ?? 0) + 1;
      set({ filerTarget: { sessionId, path, token } });
      if (!get().panels.filer) get().togglePanel("filer");
    },

    startFilerFollow(sessionId) {
      if (!followableTab(sessionId)) {
        set({ status: t("status.followUnavailable") });
        return;
      }
      const from = followMode(get().filerFollow, sessionId);
      if (from !== "following") {
        set({ filerFollow: startFollowing(get().filerFollow, sessionId) });
      }
      // The button lives in the panel, so this is the on-screen case; a call
      // made while it is hidden only sets the mode, and the panel syncs the
      // directory itself when it is shown again.
      if (!filerShows(sessionId)) return;
      void (async () => {
        const sync = await resolveFollow(sessionId);
        // A local shell on another host paused the follow and said so;
        // anything else that stopped following must not be navigated either.
        if (followMode(get().filerFollow, sessionId) !== "following") return;
        if (sync === null) {
          // Neither a report nor the backend could name a directory. The mode
          // stays on: the next report, if one comes, follows from there.
          set({ status: t("status.followUnavailable") });
          return;
        }
        showDirectory(sessionId, sync.path);
        if (sync.fromQuery) {
          // The backend named this directory: the shell itself reports none,
          // so later `cd`s will not move the Filer and the status says so.
          set({ status: t("status.followInitialOnly") });
        } else if (from === "paused") {
          // Switching it on from off navigates the Filer, which is its own
          // feedback; resuming a paused follow says the path it came back to.
          set({ status: t("status.followResumed", { path: sync.path }) });
        }
      })();
    },

    stopFilerFollow(sessionId) {
      reports.cancel(sessionId);
      const modes = get().filerFollow;
      if (followMode(modes, sessionId) === "off") return;
      set({ filerFollow: stopFollowing(modes, sessionId) });
    },

    pauseFilerFollow(sessionId) {
      const modes = get().filerFollow;
      if (followMode(modes, sessionId) !== "following") return;
      reports.cancel(sessionId);
      set({
        filerFollow: pauseFollowing(modes, sessionId),
        status: t("status.followPausedManual"),
      });
    },

    terminalCwdReported(sessionId, path, host = "") {
      // Only the session the Filer shows is followed, and only while the panel
      // is on screen: a hidden Filer must collect no listings, and it syncs
      // itself from the terminal's latest report when it is shown again.
      if (!filerShows(sessionId) || followMode(get().filerFollow, sessionId) !== "following") {
        return;
      }
      if (!followableTab(sessionId)) return;
      reports.push(sessionId, { host, path });
    },

    async resolveFilerFollow(sessionId) {
      if (!filerShows(sessionId) || followMode(get().filerFollow, sessionId) !== "following") {
        return null;
      }
      const sync = await resolveFollow(sessionId);
      return sync === null ? null : sync.path;
    },
  };
};
