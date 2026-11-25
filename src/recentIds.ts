/**
 * The storage half of a "recently used" list: read, prepend, write.
 *
 * This was written three times over - recentProfiles, quickConnectRecents and
 * commandPalette each carried their own byte-identical copy of safeStorage, the
 * load loop and the cap-and-write bodies, and each had its own test file
 * re-testing the same rules. A rule change (trimming, key versioning) had to be
 * made and re-tested three times.
 */
export interface StorageLike {
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

/** Newest first; anything that is not a non-empty string, or a repeat, is dropped. */
export function loadIds(
  key: string,
  limit: number,
  storage: StorageLike | null = safeStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value || ids.includes(value)) continue;
      ids.push(value);
      if (ids.length >= limit) break;
    }
    return ids;
  } catch {
    return [];
  }
}

/** Puts an id at the front, dropping its older copy and the ones that fall off. */
export function pushId(ids: readonly string[], id: string, limit: number): string[] {
  return [id, ...ids.filter((value) => value !== id)].slice(0, limit);
}

/** A full quota costs the list, never the action that tried to record it. */
export function saveIds(
  ids: readonly string[],
  key: string,
  limit: number,
  storage: StorageLike | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(ids.slice(0, limit)));
  } catch {
    // Deliberately empty: see the note above.
  }
}
