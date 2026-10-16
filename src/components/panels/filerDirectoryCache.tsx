import { useStore } from "../../store";
import type { FileEntry } from "../../types";

/** `lastPaths` key for the local file system, which every local tab shares. */
export const LOCAL_SOURCE = "";

/**
 * The directory last shown for each source (a remote session id, or
 * `LOCAL_SOURCE`), so switching back to a session returns to where the user
 * was browsing instead of its home (issue #74). Module level so hiding the
 * panel keeps it too; entries for closed sessions are pruned as others are
 * recorded.
 */
export const lastPaths = new Map<string, string>();

/**
 * The last listing of each remote directory, shown while a fresh one is on its
 * way (stale-while-revalidate). Switching back to an SSH tab used to leave the
 * panel on the previous session's rows until a full SFTP round trip and a JSON
 * parse of the directory finished. Local listings are not cached: they are
 * cheap and the disk is the source of truth. Bounded, oldest dropped first.
 */
export const LISTING_CACHE_LIMIT = 24;

export const listingCache = new Map<string, FileEntry[]>();

export const listingKey = (source: string, path: string) => `${source}\u0000${path}`;

export const rememberListing = (
  source: string,
  requested: string,
  path: string,
  entries: FileEntry[],
) => {
  for (const key of new Set([listingKey(source, requested), listingKey(source, path)])) {
    listingCache.delete(key);
    listingCache.set(key, entries);
  }
  while (listingCache.size > LISTING_CACHE_LIMIT) {
    listingCache.delete(listingCache.keys().next().value as string);
  }
};

/** Whether a fresh listing shows the same rows as the one on screen. */
export const sameListing = (a: readonly FileEntry[], b: readonly FileEntry[]) =>
  a.length === b.length &&
  a.every((entry, i) => {
    const other = b[i];
    return (
      entry.path === other.path &&
      entry.size === other.size &&
      entry.modified === other.modified &&
      entry.isDir === other.isDir &&
      entry.permissions === other.permissions
    );
  });

export const rememberPath = (source: string, path: string) => {
  const open = new Set(useStore.getState().tabs.map((tab) => tab.info.id));
  for (const key of lastPaths.keys()) {
    if (key !== LOCAL_SOURCE && !open.has(key)) lastPaths.delete(key);
  }
  lastPaths.set(source, path);
};
