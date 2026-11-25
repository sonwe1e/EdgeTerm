import { loadIds, pushId, saveIds, type StorageLike } from "./recentIds";
import { RECENT_PROFILES_KEY } from "./persistKeys";

/**
 * The saved sessions this machine actually connected to, newest first. It is
 * what lets a list of forty profiles say which handful the reader is working
 * with, without a "favourites" flag they would have to maintain by hand.
 */
export const RECENT_PROFILES_LIMIT = 6;

/** Profile ids, newest first; anything that is not a non-empty string is dropped. */
export function loadRecentProfiles(storage: StorageLike | null = null): string[] {
  return loadIds(RECENT_PROFILES_KEY, RECENT_PROFILES_LIMIT, storage ?? undefined);
}

/** Puts an id at the front, dropping its older copy and the ones that fall off. */
export function rememberProfile(ids: readonly string[], id: string): string[] {
  return pushId(ids, id, RECENT_PROFILES_LIMIT);
}

export function saveRecentProfiles(
  ids: readonly string[],
  storage: StorageLike | null = null,
): void {
  saveIds(ids, RECENT_PROFILES_KEY, RECENT_PROFILES_LIMIT, storage ?? undefined);
}
