import { isFileSession, type SessionKind, type SessionState } from "./types";

/**
 * Synchronized input: what the reader types in the focused session is also
 * written to every other connected shell. It is the one feature where a
 * mistake reaches production machines at once, so the rule for "which
 * sessions receive it" is deliberately strict and lives here, away from the
 * terminal and the store, so it can be tested on its own:
 *
 * - only a connected session has anywhere to write;
 * - a file session (SFTP/FTP) has a browser, not a shell, so it never gets
 *   keystrokes it would not understand;
 * - the source keeps its own normal path and is never written twice.
 *
 * Every shell kind is a target (SSH, local, serial, telnet): that is what
 * "synchronized input" means to the people who use it — one command line,
 * every pane.
 */
interface BroadcastTab {
  info: { id: string; kind: SessionKind };
  state: SessionState;
  /** The saved session's group, when it has one; group-level exclusions read it. */
  profile?: { groupId?: string | null };
}

export function broadcastTargets(
  tabs: readonly BroadcastTab[],
  sourceId: string | null,
  excluded: readonly string[] = [],
  excludedGroups: readonly string[] = [],
): string[] {
  if (!sourceId) return [];
  const targets: string[] = [];
  for (const tab of tabs) {
    if (tab.info.id === sourceId) continue;
    if (tab.state !== "connected") continue;
    if (isFileSession(tab.info.kind)) continue;
    // Unchecked in the targets list: this shell is connected but the reader
    // decided it should not receive synchronized input.
    if (excluded.includes(tab.info.id)) continue;
    // A whole group can be left out at once: with ten hosts in "production",
    // unchecking them one by one is how a mistake happens.
    const groupId = tab.profile?.groupId;
    if (groupId && excludedGroups.includes(groupId)) continue;
    targets.push(tab.info.id);
  }
  return targets;
}

/** True when there is anywhere for the typed bytes to go besides the source. */
export const canBroadcast = (
  tabs: readonly BroadcastTab[],
  sourceId: string | null,
  excluded: readonly string[] = [],
  excludedGroups: readonly string[] = [],
): boolean => broadcastTargets(tabs, sourceId, excluded, excludedGroups).length > 0;
/**
 * Replies xterm itself sends when a program queries the terminal (device
 * attributes, cursor position, terminal capabilities). They arrive on the same
 * channel as typed input, so without this filter a broadcast would also send
 * one pane's answer to a query into every other shell. The forms are fixed
 * protocol reports and cannot be produced by typing a key, which is why an
 * exact match is safe here (an arrow key is `\x1b[A`, never `\x1b[?1;2c`).
 */
export function isTerminalResponse(data: string): boolean {
  if (!data.startsWith("\x1b[")) return data.startsWith("\x1bP") && data.endsWith("\x1b\\");
  return (
    // DA1 / DA2 / DA3.
    /^\x1b\[[>?]?[0-9;]*c$/.test(data) ||
    // Device status report and cursor position report.
    /^\x1b\[[0-9;]*n$/.test(data) ||
    /^\x1b\[[0-9]+;[0-9]+R$/.test(data) ||
    // XTVERSION.
    /^\x1b\[>[0-9;]*x$/.test(data)
  );
}
