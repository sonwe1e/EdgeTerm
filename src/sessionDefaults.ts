import {
  randomSessionColor,
  type SessionGroup,
  type SessionKind,
  type SessionProfile,
} from "./types";

/**
 * The starting point shared by every new session. It lives outside the dialog
 * because a session can also be started from a place that never opens it — a
 * link in the terminal output — and both must begin from the same defaults.
 */
const BLANK_SESSION: SessionProfile = {
  id: "",
  name: "",
  kind: "ssh",
  port: 22,
  auth: "password",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

/** The port a kind starts on, or the current value when it has no opinion. */
export const defaultSessionPort = (
  kind: SessionKind,
  current?: number | null,
): number | undefined =>
  kind === "ssh" || kind === "sftp"
    ? (current ?? 22)
    : kind === "ftp"
      ? (current ?? 21)
      : kind === "telnet"
        ? (current ?? 23)
        : (current ?? undefined);

/**
 * A new session's starting profile. With a group, the group decides the kind
 * and is preselected; a file-session group is stored under the canonical
 * "ftp" kind, so a session created in it starts on the encrypted protocol the
 * way picking (S)FTP by hand does.
 */
export function newSessionProfile(group?: SessionGroup): SessionProfile {
  if (!group) return { ...BLANK_SESSION, color: randomSessionColor() };
  const kind: SessionKind = group.kind === "ftp" ? "sftp" : group.kind;
  const port = defaultSessionPort(kind);
  return {
    ...BLANK_SESSION,
    kind,
    groupId: group.id,
    ...(port === undefined ? {} : { port }),
    color: randomSessionColor(),
  };
}
