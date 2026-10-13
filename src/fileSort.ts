import { SORT_STORAGE_KEY } from "./persistKeys";
import type { FileEntry } from "./types";

export type SortKey = "name" | "modified" | "size";
export type SortDirection = "asc" | "desc";

export interface FileSort {
  key: SortKey;
  direction: SortDirection;
}

export { SORT_STORAGE_KEY };

export const DEFAULT_FILE_SORT: FileSort = { key: "name", direction: "asc" };

const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size"];
const DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Clicking a column caption: a new key starts ascending, the active one flips. */
export function toggleFileSort(current: FileSort, key: SortKey): FileSort {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

// One collator for every name comparison. Constructing an ICU collator is
// orders of magnitude more expensive than comparing with one, and a sort of
// a large directory runs the comparator tens of thousands of times — the
// options are exactly what `localeCompare` was given per call before.
const NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareNames(a: string, b: string): number {
  // Numeric so file2 sorts before file10, the way Explorer and Finder do.
  return NAME_COLLATOR.compare(a, b);
}

/**
 * Orders a listing for display. Directories stay ahead of files under every
 * key (the backends list them that way too), and a modified time the server
 * did not report sorts last whichever way the direction points.
 *
 * The default order passes the listing through untouched: every backend
 * already lists directories first and names in case-insensitive order, and
 * that byte-ish order differs from this collator's numeric order (file10
 * before file2). A user who never touched the columns keeps seeing exactly
 * what the backend produced.
 */
export function sortFileEntries(
  entries: readonly FileEntry[],
  sort: FileSort,
): FileEntry[] {
  if (sort.key === DEFAULT_FILE_SORT.key && sort.direction === DEFAULT_FILE_SORT.direction) {
    return [...entries];
  }
  const descending = sort.direction === "desc";
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let order = 0;
    if (sort.key === "name") {
      order = compareNames(a.name, b.name);
    } else if (sort.key === "modified") {
      if (a.modified === null || b.modified === null) {
        // Unknown times sort last whichever way the direction points, so the
        // verdict is returned before the flip below can reverse it.
        if (a.modified === null && b.modified === null) return 0;
        return a.modified === null ? 1 : -1;
      }
      order = a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0;
    } else {
      order = a.size < b.size ? -1 : a.size > b.size ? 1 : 0;
    }
    return descending ? -order : order;
  });
}

/** A `FileSort` from an untrusted source (a settings file); null when invalid. */
export function parseFileSort(value: unknown): FileSort | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { key?: unknown; direction?: unknown };
  if (
    typeof candidate.key !== "string" ||
    !SORT_KEYS.includes(candidate.key as SortKey) ||
    (candidate.direction !== "asc" && candidate.direction !== "desc")
  ) {
    return null;
  }
  return { key: candidate.key as SortKey, direction: candidate.direction };
}

export function loadFileSort(): FileSort {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SORT_STORAGE_KEY) ?? "null",
    );
    if (
      SORT_KEYS.includes(parsed?.key) &&
      DIRECTIONS.includes(parsed?.direction)
    ) {
      return { key: parsed.key, direction: parsed.direction };
    }
  } catch {
    // A corrupt or blocked entry falls through to the default.
  }
  return DEFAULT_FILE_SORT;
}

export function saveFileSort(sort: FileSort): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Storage full or blocked; the in-memory sort still applies.
  }
}
