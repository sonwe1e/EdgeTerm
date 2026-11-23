import { QUICK_CONNECT_RECENTS_KEY } from "./persistKeys";

/**
 * The hosts the reader connected to from the palette's field, newest first, so
 * the second visit to the same machine is one keystroke instead of a retyped
 * address. Only the label is kept — no password, no profile, nothing the
 * session editor would have written down.
 */
export const RECENT_TARGETS_LIMIT = 4;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const safeStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Labels this machine connected to, newest first; junk and repeats dropped. */
export function loadRecentTargets(storage: StorageLike | null = safeStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(QUICK_CONNECT_RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const labels: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value || labels.includes(value)) continue;
      labels.push(value);
      if (labels.length >= RECENT_TARGETS_LIMIT) break;
    }
    return labels;
  } catch {
    return [];
  }
}

/** Puts a label at the front, dropping its older copy and the ones that fall off. */
export function rememberTarget(labels: readonly string[], label: string): string[] {
  return [label, ...labels.filter((value) => value !== label)].slice(0, RECENT_TARGETS_LIMIT);
}

export function saveRecentTargets(
  labels: readonly string[],
  storage: StorageLike | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      QUICK_CONNECT_RECENTS_KEY,
      JSON.stringify(labels.slice(0, RECENT_TARGETS_LIMIT)),
    );
  } catch {
    // A full quota costs the recents list, never the connection.
  }
}
