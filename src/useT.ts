import { useMemo } from "react";

import { translate, type TParams, type Translate } from "./i18n";
import { useStore } from "./store";

/**
 * The translator for a React component, bound to the language in force. It is
 * memoised on the language, so a component that only reads labels re-renders
 * when the language changes and not on any other store update.
 *
 * Imperative code (actions.ts, the store's own status strings) uses the
 * module-level `t` from i18n.ts instead.
 */
export function useT(): Translate {
  const language = useStore((s) => s.language);
  return useMemo<Translate>(
    () => (key, params?: TParams) => translate(language, key, params),
    [language],
  );
}
