import { openSession } from "../actions";
import { t } from "../i18n";
import { useStore, type Tab } from "../store";
import { getController } from "../terminalRegistry";
import { type SessionProfile } from "../types";
import type { ServerRef } from "./types";

/**
 * Resolves a project's server to a live session, and opens one when the user
 * asks. Records never hold the session id: it disappears with the window,
 * while `profileId` (or the endpoint) is what a project is bound to.
 */

const endpointOf = (server: ServerRef): string => `${server.host}:${server.port || 22}`;

export function connectedTabFor(server: ServerRef): Tab | undefined {
  const endpoint = endpointOf(server);
  return useStore
    .getState()
    .tabs.find(
      (tab) =>
        tab.state === "connected" &&
        tab.info.kind === "ssh" &&
        tab.info.address === endpoint &&
        (tab.info.profileId === server.profileId ||
          (tab.profile.username ?? "") === server.username),
    );
}

export interface ProfileMatch {
  profile: SessionProfile | null;
  /** The saved login still names the same endpoint. */
  exact: boolean;
  /** The id exists, but its host, port or user changed since the project
   * recorded this server. Connecting anyway would put a run on a different
   * machine under the old identity. */
  drift: boolean;
}

export function resolveProfile(server: ServerRef): ProfileMatch {
  const profiles = useStore.getState().profiles;
  const byId = profiles.find(
    (profile) => profile.id === server.profileId && profile.kind === "ssh",
  );
  if (byId) {
    const drift =
      (byId.host ?? "") !== server.host ||
      (byId.port ?? 22) !== (server.port || 22) ||
      (byId.username ?? "") !== server.username;
    return { profile: byId, exact: !drift, drift };
  }
  const fallback = profiles.find(
    (profile) =>
      profile.kind === "ssh" &&
      (profile.host ?? "") === server.host &&
      (profile.port ?? 22) === (server.port || 22) &&
      (profile.username ?? "") === server.username,
  );
  return { profile: fallback ?? null, exact: false, drift: false };
}

async function waitForSession(id: string): Promise<Tab> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const tab = useStore.getState().tabs.find((item) => item.info.id === id);
    if (!tab) throw new Error(t("wb.sessionClosed"));
    if (tab.state === "connected") return tab;
    if (tab.state === "error" || tab.state === "closed") {
      throw new Error(tab.message ?? t("wb.sessionFailed"));
    }
    if (Date.now() > deadline) throw new Error(t("wb.sessionTimeout"));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

export async function ensureSessionFor(server: ServerRef): Promise<string> {
  const live = connectedTabFor(server);
  if (live) return live.info.id;
  const { profile, drift } = resolveProfile(server);
  if (!profile) throw new Error(t("wb.profileMissing"));
  if (drift) throw new Error(t("wb.profileDrift"));
  const opened = await openSession(profile);
  if (!opened) throw new Error(t("wb.sessionFailed"));
  await waitForSession(opened);
  return opened;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function terminalCommandFor(root: string, env: string): string {
  const prelude = env.trim();
  const base = `cd -- ${shellQuote(root)}`;
  return prelude ? `${base} && ${prelude}` : base;
}

/**
 * Opens (or focuses) the terminal tab a project runs in, and puts its shell
 * in the project directory. A new tab is tagged with the project so the
 * terminal view can show which one belongs to it.
 */
export async function openWorkspaceTerminal(
  workspaceId: string,
  workspaceName: string,
  server: ServerRef,
  root: string,
  env: string,
): Promise<string> {
  const existing = useStore
    .getState()
    .tabs.find(
      (tab) =>
        tab.workspaceId === workspaceId && tab.state === "connected" && tab.info.kind === "ssh",
    );
  if (existing) {
    useStore.getState().setActive(existing.info.id);
    return existing.info.id;
  }
  const sessionId = await ensureSessionFor(server);
  useStore.getState().setTabWorkspace(sessionId, workspaceId, `${workspaceName} · ${server.host}`);
  await waitForSession(sessionId);
  // The shell may still be printing its prompt; one write after the backend
  // reports connected is enough, and a failure only costs the `cd`.
  getController(sessionId)?.writeText(`${terminalCommandFor(root, env)}\n`);
  useStore.getState().setActive(sessionId);
  return sessionId;
}
