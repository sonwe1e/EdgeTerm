import type { PortForward, PortForwardSpec } from "./api";
import { errorText } from "./errorInfo";
import { t } from "./i18n";
import type { SessionKind } from "./types";

/**
 * Links printed in an SSH terminal that point at the server's own loopback
 * (`http://localhost:6006/`) cannot be opened from this machine: that address
 * would reach a service on the local computer, not the one on the SSH host.
 * Ctrl+clicking one opens it through a temporary local SSH tunnel instead.
 *
 * The rules and the start/open sequence are plain functions over injected
 * dependencies, so the behaviour is testable without Tauri: see
 * `classifyTerminalUrl` and `createRemotePreview`.
 */

/** How long a freshly started tunnel may take to report `listening`. */
export const TUNNEL_READY_TIMEOUT_MS = 10_000;

/** How often a starting tunnel is re-read while the click waits for it. */
export const TUNNEL_READY_POLL_MS = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TerminalUrlDecision {
  /**
   * `forward`: the address belongs to the SSH server and needs a tunnel.
   * `direct`: open the link as written.
   */
  kind: "direct" | "forward";
  /** The host the SSH server dials; "" unless `kind` is `forward`. */
  targetHost: string;
  /** The port the SSH server dials; 0 unless `kind` is `forward`. */
  targetPort: number;
  /** The link's path, query and fragment as written; "" for a direct open. */
  suffixPath: string;
}

interface ParsedWebUrl {
  scheme: "http" | "https";
  hostname: string;
  port: number;
  suffixPath: string;
}

/** Loopback and wildcard names that mean the server's own machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

/**
 * `URL.hostname` keeps the brackets of an IPv6 literal; comparisons and the
 * addresses built below want the bare form. A trailing root dot is ignored.
 */
function bareHostname(hostname: string): string {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.replace(/\.$/, "").toLowerCase();
}

/** The address the SSH server dials for a link to its own listener. */
function remoteTarget(hostname: string): string {
  switch (hostname) {
    // A wildcard listener accepts the loopback of the same address family.
    case "0.0.0.0":
      return "127.0.0.1";
    case "::":
      return "::1";
    // The server's "localhost" is this side of the tunnel, where 127.0.0.1 is
    // the address most programs bind for a local preview server.
    case "localhost":
      return "127.0.0.1";
    default:
      return hostname;
  }
}

function parseWebUrl(raw: string): ParsedWebUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // URL normalises an explicit default port away, so put it back for dialling.
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    hostname: url.hostname,
    port,
    suffixPath: `${url.pathname}${url.search}${url.hash}`,
  };
}

/**
 * Whether a terminal link opens as written or needs a tunnel through an SSH
 * session. Only SSH has a remote side to forward to: a local, serial or telnet
 * terminal's loopback already is this machine's. Public addresses and
 * non-web schemes always open directly, as do links that cannot be parsed.
 */
export function classifyTerminalUrl(
  sessionKind: SessionKind | null | undefined,
  rawUrl: string,
): TerminalUrlDecision {
  const direct: TerminalUrlDecision = {
    kind: "direct",
    targetHost: "",
    targetPort: 0,
    suffixPath: "",
  };
  if (sessionKind !== "ssh") return direct;
  const parsed = parseWebUrl(rawUrl);
  if (!parsed) return direct;
  const hostname = bareHostname(parsed.hostname);
  if (!LOOPBACK_HOSTS.has(hostname)) return direct;
  return {
    kind: "forward",
    targetHost: remoteTarget(hostname),
    targetPort: parsed.port,
    suffixPath: parsed.suffixPath,
  };
}

/** A local listener exposed by one tunnel. */
interface LocalRoute {
  /** Host for the browser URL; an IPv6 literal keeps its brackets. */
  host: string;
  port: number;
}

export interface RemotePreviewDeps {
  startForward: (owner: string, spec: PortForwardSpec) => Promise<PortForward>;
  listForwards: () => Promise<PortForward[]>;
  stopForward: (id: string) => Promise<void>;
  removeForward: (id: string) => Promise<void>;
  /** Opens a URL in the system browser; rejects when it cannot. */
  openUrl: (url: string) => Promise<void>;
  /** Test seam for the poll interval; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Reports a message on the terminal's status line; `error` paints it as one. */
export type StatusNotify = (message: string, error?: boolean) => void;

export interface RemotePreview {
  /**
   * Opens `uri` for a session. A link to the server's own loopback reuses or
   * starts a tunnel owned by `sessionId`, waits until it listens, then opens
   * the assigned local port with the link's path, query and fragment intact.
   */
  openSessionUrl(
    sessionId: string,
    sessionKind: SessionKind | null | undefined,
    uri: string,
    notify?: StatusNotify,
  ): Promise<void>;
}

interface PendingTunnel {
  route: Promise<LocalRoute | null>;
  /** URLs this batch already opened, so a double click still opens one tab. */
  opened: Set<string>;
}

const READY_ATTEMPTS = Math.ceil(TUNNEL_READY_TIMEOUT_MS / TUNNEL_READY_POLL_MS);

/** The host a browser on this machine can use for a tunnel's listener. */
function browserHost(listenHost: string): string {
  const host = bareHostname(listenHost.trim());
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

function routeOf(row: PortForward): LocalRoute {
  return { host: browserHost(row.spec.listenHost), port: row.spec.listenPort };
}

/** Whether `row` is the tunnel this session would reuse for that endpoint. */
function ownsEndpoint(
  row: PortForward,
  owner: string,
  targetHost: string,
  targetPort: number,
): boolean {
  return (
    row.owner === owner &&
    row.spec.direction === "local" &&
    (row.spec.targetHost ?? "").trim() === targetHost &&
    (row.spec.targetPort ?? 0) === targetPort &&
    (row.status === "starting" || row.status === "listening")
  );
}

/**
 * A per-window preview factory. The returned instance remembers the tunnel it
 * is bringing up per (session, remote host, remote port), so a second click on
 * the same endpoint joins that work instead of starting another forward.
 * Nothing stops a working tunnel: it lives until the user stops it in the
 * Tunnels list or the session itself closes.
 */
export function createRemotePreview(deps: RemotePreviewDeps): RemotePreview {
  const sleep = deps.sleep ?? defaultSleep;
  const pending = new Map<string, PendingTunnel>();

  function fail(notify: StatusNotify | undefined, uri: string, error: string): null {
    notify?.(t("status.linkOpenFailed", { path: uri, error }), true);
    return null;
  }

  async function openInBrowser(uri: string, notify: StatusNotify | undefined): Promise<boolean> {
    try {
      await deps.openUrl(uri);
      return true;
    } catch (error) {
      notify?.(t("status.linkOpenError", { error: errorText(error) }), true);
      return false;
    }
  }

  async function readRow(id: string): Promise<PortForward | null> {
    const rows = await deps.listForwards();
    return rows.find((row) => row.id === id) ?? null;
  }

  async function waitUntilReady(
    initial: PortForward,
    uri: string,
    notify: StatusNotify | undefined,
  ): Promise<LocalRoute | null> {
    let row = initial;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
      if (row.status === "listening") return routeOf(row);
      if (row.status === "error") {
        return fail(notify, uri, row.error ?? "the tunnel failed before it was ready");
      }
      if (row.status === "stopped" || row.status === "stopping") {
        return fail(notify, uri, "the tunnel stopped before it was ready");
      }
      await sleep(TUNNEL_READY_POLL_MS);
      const next = await readRow(row.id);
      if (!next) return fail(notify, uri, "the tunnel disappeared before it was ready");
      row = next;
    }
    return fail(notify, uri, "the tunnel did not start listening in time");
  }

  /** Stops and forgets a tunnel this click created but could not use. */
  async function discard(id: string): Promise<void> {
    try {
      await deps.stopForward(id);
    } catch {
      // Still stopping: leave the record for the Tunnels list to settle it.
      return;
    }
    try {
      await deps.removeForward(id);
    } catch {
      // The listener is closed; a leftover record is harmless and removable.
    }
  }

  async function startOrReuse(
    sessionId: string,
    targetHost: string,
    targetPort: number,
    uri: string,
    notify: StatusNotify | undefined,
  ): Promise<LocalRoute | null> {
    let created: string | null = null;
    try {
      let existing: PortForward | null = null;
      try {
        const rows = await deps.listForwards();
        existing = rows.find((row) => ownsEndpoint(row, sessionId, targetHost, targetPort)) ?? null;
      } catch {
        // Without the list, starting a fresh tunnel is still the best effort:
        // a duplicate is better than a click that does nothing.
      }
      if (existing) return await waitUntilReady(existing, uri, notify);
      notify?.(t("status.linkForwarding", { url: uri }));
      const started = await deps.startForward(sessionId, {
        direction: "local",
        listenHost: "127.0.0.1",
        listenPort: 0,
        targetHost,
        targetPort,
      });
      created = started.id;
      const route = await waitUntilReady(started, uri, notify);
      if (route) {
        created = null;
        return route;
      }
      return null;
    } catch (error) {
      return fail(notify, uri, errorText(error));
    } finally {
      // Only a tunnel this click started is ever torn down: a forward the user
      // made in the Tunnels list belongs to them even when it is unusable.
      if (created) await discard(created);
    }
  }

  async function openSessionUrl(
    sessionId: string,
    sessionKind: SessionKind | null | undefined,
    uri: string,
    notify?: StatusNotify,
  ): Promise<void> {
    const decision = classifyTerminalUrl(sessionKind, uri);
    if (decision.kind === "direct" || !sessionId) {
      await openInBrowser(uri, notify);
      return;
    }
    const key = `${sessionId}\u0000${decision.targetHost}\u0000${decision.targetPort}`;
    let entry = pending.get(key);
    if (!entry) {
      const created: PendingTunnel = {
        route: startOrReuse(sessionId, decision.targetHost, decision.targetPort, uri, notify),
        opened: new Set(),
      };
      pending.set(key, created);
      const clear = () => {
        if (pending.get(key) === created) pending.delete(key);
      };
      void created.route.then(clear, clear);
      entry = created;
    }
    const route = await entry.route;
    if (!route) return;
    const scheme = parseWebUrl(uri)?.scheme ?? "http";
    const localUrl = `${scheme}://${route.host}:${route.port}${decision.suffixPath}`;
    if (entry.opened.has(localUrl)) return;
    entry.opened.add(localUrl);
    if (await openInBrowser(localUrl, notify)) {
      notify?.(t("status.linkOpened", { url: localUrl }));
    }
  }

  return { openSessionUrl };
}
