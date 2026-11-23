import type { SessionProfile } from "./types";

/**
 * "Connect to this host" typed where the reader already is. The palette's own
 * field doubles as the target: `root@10.0.0.5:2222` opens an SSH session for
 * the length of this window, without adding a profile the reader did not ask
 * for.
 *
 * Parsing is strict on purpose: the same field is a search box, so anything
 * with spaces (a normal phrase) is not a target, and neither is a bare word
 * that happens to look like a host — `ssh` as a query must keep finding the
 * command named "ssh", not try to connect to a machine called "ssh".
 */
export interface QuickTarget {
  /** Null when the text named no user: the session then asks for one. */
  username: string | null;
  host: string;
  /** Null when the text named no port; the profile's own default then applies. */
  port: number | null;
}

/** Hostnames, IPv4 addresses and bracketed IPv6 addresses. */
const HOST = /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;
const USER = /^[a-zA-Z0-9._-]+$/;

export function parseQuickConnect(text: string): QuickTarget | null {
  const value = text.trim();
  if (value === "" || /\s/.test(value)) return null;
  const at = value.lastIndexOf("@");
  const user = at >= 0 ? value.slice(0, at) : null;
  const rest = at >= 0 ? value.slice(at + 1) : value;
  if (user !== null && (user === "" || !USER.test(user))) return null;
  // A port is the last colon outside brackets: `[::1]:22` keeps its address.
  let host = rest;
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && !rest.startsWith("[")) {
    host = rest.slice(0, colon);
    port = parsePort(rest.slice(colon + 1));
    if (port === null) return null;
  } else if (colon > 0 && rest.startsWith("[") && rest.endsWith("]") === false) {
    const close = rest.indexOf("]");
    if (close < 0) return null;
    host = rest.slice(0, close + 1);
    port = parsePort(rest.slice(close + 2));
    if (port === null) return null;
  }
  if (!HOST.test(host)) return null;
  // One bare word is a search term, not a machine: `ssh` must keep finding the
  // command named "ssh". A target says so by naming a user, a port, or a host
  // with a dot (or a bracketed address).
  const names = user !== null || port !== null || host.includes(".") || host.startsWith("[");
  return names ? { username: user, host, port } : null;
}

const parsePort = (text: string): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
};

/** What the row and the tab call this target: `user@host:port`, parts that exist. */
export function quickConnectLabel(target: QuickTarget): string {
  const user = target.username === null ? "" : `${target.username}@`;
  const port = target.port === null ? "" : `:${target.port}`;
  return `${user}${target.host}${port}`;
}

/**
 * The profile to open: a fresh SSH session carrying the parsed fields, with no
 * id — nothing is saved, and the tab's name is the target the reader typed.
 */
export function quickConnectProfile(target: QuickTarget, base: SessionProfile): SessionProfile {
  return {
    ...base,
    id: "",
    name: quickConnectLabel(target),
    kind: "ssh",
    host: target.host,
    port: target.port ?? base.port,
    username: target.username ?? base.username,
  };
}
