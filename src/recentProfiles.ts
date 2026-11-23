import { RECENT_PROFILES_KEY } from "./persistKeys";

/**
 * The saved sessions this machine actually connected to, newest first. It is
 * what lets a list of forty profiles say which handful the reader is working
 * with, without a "favourites" flag they would have to maintain by hand.
 */
export const RECENT_PROFILES_LIMIT = 6;

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

/** Profile ids, newest first; anything that is not a non-empty string is dropped. */
export function loadRecentProfiles(storage: StorageLike | null = safeStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_PROFILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value || ids.includes(value)) continue;
      ids.push(value);
      if (ids.length >= RECENT_PROFILES_LIMIT) break;
    }
    return ids;
  } catch {
    return [];
  }
}

/** Puts an id at the front, dropping its older copy and the ones that fall off. */
export function rememberProfile(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((value) => value !== id)].slice(0, RECENT_PROFILES_LIMIT);
}

export function saveRecentProfiles(
  ids: readonly string[],
  storage: StorageLike | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_PROFILES_KEY, JSON.stringify(ids.slice(0, RECENT_PROFILES_LIMIT)));
  } catch {
    // A full quota costs the list, never the connection.
  }
}
