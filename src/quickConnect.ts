import type { SessionProfile } from "./types";

/**
 * "Connect to this host" typed where the reader already is. The palette's own
 * field doubles as the target: `root@10.0.0.5:2222` opens an SSH session for
 * the length of this window, without adding a profile the reader did not ask
 * for.
 *
 * Accepted shapes: `host`, `user@host`, `host:port`, `user@host:port`,
 * `[::1]:port` for IPv6, and any of those behind an `ssh://` scheme, which is
 * how a link pasted from a ticket or a wiki arrives.
 *
 * A target must say so — `@`, a port, a host with a dot, or a bracketed
 * address. One bare word is a search term, so `ssh` keeps finding the command
 * named "ssh" instead of dialling a machine called "ssh".
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
  const raw = text.trim().replace(/^ssh:\/\//i, "");
  if (raw === "" || /\s/.test(raw)) return null;
  const at = raw.lastIndexOf("@");
  const username = at >= 0 ? raw.slice(0, at) : null;
  if (username !== null && (username === "" || !USER.test(username))) return null;
  const address = at >= 0 ? raw.slice(at + 1) : raw;
  const parsed = splitAddress(address);
  if (!parsed) return null;
  const { host, port } = parsed;
  if (!HOST.test(host)) return null;
  const says = username !== null || port !== null || host.includes(".") || host.startsWith("[");
  return says ? { username, host, port } : null;
}

/** Splits `host`, `host:port` and `[v6]:port`; null when the shape is wrong. */
const splitAddress = (address: string): { host: string; port: number | null } | null => {
  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    if (close < 0) return null;
    const host = address.slice(0, close + 1);
    const rest = address.slice(close + 1);
    if (rest === "") return { host, port: null };
    if (!rest.startsWith(":")) return null;
    const port = parsePort(rest.slice(1));
    return port === null ? null : { host, port };
  }
  const colon = address.lastIndexOf(":");
  if (colon < 0) return { host: address, port: null };
  // An unbracketed address with the colon it needs is not an address: IPv6
  // must be written in brackets so the port stays unambiguous.
  if (address.indexOf(":") !== colon) return null;
  const port = parsePort(address.slice(colon + 1));
  return port === null ? null : { host: address.slice(0, colon), port };
};

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
