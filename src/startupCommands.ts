import { STARTUP_COMMANDS_STORAGE_KEY } from "./persistKeys";
import { MAX_COMMAND_LENGTH } from "./snippets";

/**
 * A command a profile runs once its shell is ready — WinSCP's "logon script",
 * Xshell's "login script": `cd /srv/app && tmux attach`. Kept beside the other
 * preferences rather than in the profile file, so an old profile still loads in
 * a build that has never heard of it.
 */
export const STARTUP_COMMANDS_KEY = STARTUP_COMMANDS_STORAGE_KEY;

/** How many profiles may carry a command; past this the oldest entry wins. */
export const MAX_STARTUP_PROFILES = 200;

/**
 * One line is what a login script is: a command typed at the prompt. Newlines
 * would be a script, and a script that half-runs is worse than none, so the
 * first non-empty line is the command and the rest is dropped with the hint in
 * the dialog.
 */
export function startupLine(command: string): string {
  const line = command
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? "").slice(0, MAX_COMMAND_LENGTH);
}

/** Reads the map, dropping anything a hand-edited file could have broken. */
export function parseStartupCommands(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  let kept = 0;
  for (const [profileId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (kept >= MAX_STARTUP_PROFILES) break;
    if (typeof value !== "string" || !profileId) continue;
    const line = startupLine(value);
    if (!line) continue;
    result[profileId] = line;
    kept += 1;
  }
  return result;
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadStartupCommands(store: Storage | null = storage()): Record<string, string> {
  if (!store) return {};
  try {
    return parseStartupCommands(store.getItem(STARTUP_COMMANDS_KEY));
  } catch {
    return {};
  }
}

export function saveStartupCommands(
  commands: Record<string, string>,
  store: Storage | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(STARTUP_COMMANDS_KEY, JSON.stringify(commands));
  } catch {
    // A full quota must not take typing down with it.
  }
}
