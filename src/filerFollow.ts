/**
 * Filer directory following: the state machine and the report debounce behind
 * the directory bar's follow button. The mode is per session and runtime only
 * — it is not a preference for a saved profile, which several windows and
 * tabs share, but a decision about this window's Filer — so it lives in the
 * store and is never written anywhere.
 *
 * Everything here is pure: the store owns the data, the terminal supplies the
 * reports, and the panel reads the mode. Keeping the transitions and the
 * debounce out of both is what makes the burst, the foreign host and the
 * manual pause testable without a terminal or a server.
 */

/** How the Filer treats one terminal's directory reports. */
export type FollowMode = "off" | "following" | "paused";

/** Every session's mode; a session that is absent is "off". Never mutated. */
export type FollowModes = Record<string, FollowMode>;

/**
 * How long the last report of a burst waits before the Filer navigates. A
 * directory change is announced at every prompt, and one command can print
 * two reports (a subshell, a shell function); moving once after the burst
 * leaves one listing instead of one per report, and 400 ms stays under the
 * pause a user reads as lag.
 */
export const FOLLOW_DEBOUNCE_MS = 400;

/** A working directory a session's shell announced; see `ReportedCwd`. */
export interface CwdReport {
  /** Host part of an OSC 7 URL; "" when the sequence carried none. */
  host: string;
  path: string;
}

/** Where a report would take the Filer. */
export type FollowDestination =
  | { kind: "path"; path: string }
  /** The session has never reported a directory to follow. */
  | { kind: "unreported" }
  /** A local shell moved to another machine; this Filer cannot show it. */
  | { kind: "foreign" };

/** The session's mode; a session nobody turned on is "off". */
export const followMode = (modes: FollowModes, sessionId: string): FollowMode =>
  modes[sessionId] ?? "off";

/**
 * The modes after the user turns following on ("Follow terminal" from off,
 * "Resume following" from paused). The record is kept when it did not change,
 * so a repeat call re-renders nothing.
 */
export function startFollowing(modes: FollowModes, sessionId: string): FollowModes {
  if (followMode(modes, sessionId) === "following") return modes;
  return { ...modes, [sessionId]: "following" };
}

/**
 * The modes after the user browsed the Filer by hand. Only a followed session
 * pauses: an off or already-paused session keeps its mode, so a manual reload
 * cannot re-pause a follow the user has already taken over.
 */
export function pauseFollowing(modes: FollowModes, sessionId: string): FollowModes {
  if (followMode(modes, sessionId) !== "following") return modes;
  return { ...modes, [sessionId]: "paused" };
}

/** The modes after the user stops: "off" is the absence of an entry. */
export function stopFollowing(modes: FollowModes, sessionId: string): FollowModes {
  if (modes[sessionId] === undefined) return modes;
  const next: Record<string, FollowMode> = { ...modes };
  delete next[sessionId];
  return next;
}

const firstLabel = (host: string): string => host.toLowerCase().split(".")[0];

/**
 * Whether an OSC 7 host names some other machine. A local shell the user
 * ssh'd away from reports that server's host, and its `/home/me` must not
 * replace this machine's directory in the Filer. A host this machine cannot be
 * compared against is treated as foreign rather than guessed — the same rule
 * `isThisHost` applies on the reveal path in actions.ts.
 */
export function foreignHost(host: string, hostname: string): boolean {
  if (host === "" || host === "localhost") return false;
  if (hostname === "") return true;
  return firstLabel(host) !== firstLabel(hostname);
}

/** `/C:/Users/me` from a Windows shell's OSC 7 URL → `C:\Users\me`. */
export function localShellPath(path: string, windows: boolean): string {
  if (!windows) return path;
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  if (!drive) return path;
  return `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}`;
}

/**
 * Where a report takes the Filer. An SSH session's report always names its own
 * server — the Filer is browsing that machine, so the path is ours to show —
 * and only a local shell can have moved somewhere this Filer cannot reach.
 */
export function followDestination(
  report: CwdReport | null,
  options: { local: boolean; hostname: string; windows: boolean },
): FollowDestination {
  if (report === null) return { kind: "unreported" };
  if (!options.local) return { kind: "path", path: report.path };
  if (foreignHost(report.host, options.hostname)) return { kind: "foreign" };
  return { kind: "path", path: localShellPath(report.path, options.windows) };
}

/** The timers the queue schedules through; a test passes one it controls. */
export interface FollowClock {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Timers as the window runs them, read per call so fake timers apply. */
const systemClock: FollowClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface FollowQueue {
  /** Replaces the report already waiting for the session: only the last lands. */
  push: (sessionId: string, report: CwdReport) => void;
  /** Drops a waiting report; following stopped or the user took over. */
  cancel: (sessionId: string) => void;
}

/**
 * One timer per session, holding that session's most recent report. The
 * directory that lands is decided when the timer fires, not when the report
 * arrived: the caller re-reads the store there, so a follow paused or stopped
 * in the meantime moves nothing.
 */
export function createFollowQueue(
  flush: (sessionId: string, report: CwdReport) => void,
  clock: FollowClock = systemClock,
  delayMs: number = FOLLOW_DEBOUNCE_MS,
): FollowQueue {
  const pending = new Map<string, { handle: ReturnType<typeof setTimeout>; report: CwdReport }>();
  return {
    push(sessionId, report) {
      const waiting = pending.get(sessionId);
      if (waiting) clock.clearTimeout(waiting.handle);
      const handle = clock.setTimeout(() => {
        const latest = pending.get(sessionId);
        if (!latest) return;
        pending.delete(sessionId);
        flush(sessionId, latest.report);
      }, delayMs);
      pending.set(sessionId, { handle, report });
    },
    cancel(sessionId) {
      const waiting = pending.get(sessionId);
      if (!waiting) return;
      clock.clearTimeout(waiting.handle);
      pending.delete(sessionId);
    },
  };
}
