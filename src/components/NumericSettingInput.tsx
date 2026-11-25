import { useEffect, useRef, useState } from "react";

interface Props {
  "aria-label": string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}

/**
 * Bounded integer input that keeps incomplete or temporarily out-of-range
 * keystrokes editable (for example, clearing "64" to type "128" in a 16-256
 * field). Valid integers commit immediately; blur or Enter normalizes and
 * clamps the draft back into [min, max].
 */
export function NumericSettingInput({ "aria-label": ariaLabel, value, min, max, onCommit }: Props) {
  const [draft, setDraft] = useState(() => String(value));
  const lastCommitted = useRef(value);

  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setDraft(String(value));
    }
  }, [value]);

  const commit = (next: number) => {
    if (next !== value) {
      lastCommitted.current = next;
      onCommit(next);
    }
  };

  const normalize = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    commit(clamped);
    setDraft(String(clamped));
  };

  return (
    <input
      aria-label={ariaLabel}
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const trimmed = raw.trim();
        if (trimmed === "") return;
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          commit(parsed);
        }
      }}
      onBlur={normalize}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) normalize();
      }}
    />
  );
}
