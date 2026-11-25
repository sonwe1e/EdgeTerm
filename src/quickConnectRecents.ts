import { loadIds, pushId, saveIds, type StorageLike } from "./recentIds";
import { QUICK_CONNECT_RECENTS_KEY } from "./persistKeys";

/**
 * The hosts the reader connected to from the palette's field, newest first, so
 * the second visit to the same machine is one keystroke instead of a retyped
 * address. Only the label is kept — no password, no profile, nothing the
 * session editor would have written down.
 */
export const RECENT_TARGETS_LIMIT = 4;

/** Labels this machine connected to, newest first; junk and repeats dropped. */
export function loadRecentTargets(storage: StorageLike | null = null): string[] {
  return loadIds(QUICK_CONNECT_RECENTS_KEY, RECENT_TARGETS_LIMIT, storage ?? undefined);
}

/** Puts a label at the front, dropping its older copy and the ones that fall off. */
export function rememberTarget(labels: readonly string[], label: string): string[] {
  return pushId(labels, label, RECENT_TARGETS_LIMIT);
}

export function saveRecentTargets(
  labels: readonly string[],
  storage: StorageLike | null = null,
): void {
  saveIds(labels, QUICK_CONNECT_RECENTS_KEY, RECENT_TARGETS_LIMIT, storage ?? undefined);
}
