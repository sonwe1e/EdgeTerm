import { useMemo, useRef, useState } from "react";
import type { FileEntry } from "./types";
import { useStableCallback } from "./useStableCallback";

/** Selection uses paths so sorting and virtual row unmounts keep item identity. */
export function useFileSelection(entries: readonly FileEntry[]) {
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const replace = useStableCallback((selected: Iterable<string>) => {
    const next = new Set(selected);
    anchor.current = next.values().next().value ?? null;
    setPaths(next);
  });
  const clear = useStableCallback(() => replace([]));
  const selectAll = useStableCallback(() => replace(entries.map((entry) => entry.path)));
  const select = useStableCallback((path: string, { toggle = false, range = false } = {}) => {
    const from = anchor.current === null ? -1 : entries.findIndex((entry) => entry.path === anchor.current);
    const to = entries.findIndex((entry) => entry.path === path);
    if (to < 0) return;
    if (!range || from < 0) anchor.current = path;
    setPaths((previous) => {
      if (range && from >= 0) {
        const next = toggle ? new Set(previous) : new Set<string>();
        for (let index = Math.min(from, to); index <= Math.max(from, to); index++) next.add(entries[index].path);
        return next;
      }
      if (!toggle) return new Set([path]);
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  });
  const selectedEntries = useMemo(() => entries.filter((entry) => paths.has(entry.path)), [entries, paths]);
  return { paths, selectedEntries, select, selectAll, clear, replace };
}
