import { useState } from "react";

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
 * clamps the draft back into [min, max], while unfocused renders always
 * reflect the controlled `value`.
 */
export function NumericSettingInput({ "aria-label": ariaLabel, value, min, max, onCommit }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  const normalize = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    setDraft(null);
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      aria-label={ariaLabel}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const trimmed = raw.trim();
        if (trimmed === "") return;
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max && parsed !== value) {
          onCommit(parsed);
        }
      }}
      onBlur={normalize}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) normalize();
      }}
    />
  );
}
