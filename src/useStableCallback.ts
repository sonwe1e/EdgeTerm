import { useCallback, useRef } from "react";

/**
 * A function whose identity never changes across renders but always calls
 * the latest `fn` — the "event function" pattern. Row-level callbacks are
 * passed to memoised list rows, whose skip-on-equal-props only works when
 * every prop the parent re-render would mint afresh (a new closure over
 * fresh state) arrives through here instead.
 */
export function useStableCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: Args) => latest.current(...args), []);
}
