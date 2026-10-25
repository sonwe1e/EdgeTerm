import type { CSSProperties } from "react";

import type { MessageKey } from "./i18n";

/**
 * The tints a saved command's tag can take (right-click → Color), in menu
 * order. Each name is a theme token, `--tag-<name>` in
 * foundation.styles.css, so every theme picks the shade that reads on its own
 * surfaces; a tag with no color keeps the neutral look.
 */
export const SENDER_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;

export type SenderColor = (typeof SENDER_COLORS)[number];

const NAMES = new Set<string>(SENDER_COLORS);

/** The palette name, or null for none and for a name this build lacks. */
export function senderColor(value: string | null | undefined): SenderColor | null {
  return value && NAMES.has(value) ? (value as SenderColor) : null;
}

/** The CSS color of a palette entry, for swatches. */
export const senderColorValue = (color: SenderColor) => `var(--tag-${color})`;

/** The message key a palette entry's menu label is read from. */
const LABEL_KEYS: Record<SenderColor, MessageKey> = {
  red: "sender.colorRed",
  orange: "sender.colorOrange",
  yellow: "sender.colorYellow",
  green: "sender.colorGreen",
  teal: "sender.colorTeal",
  blue: "sender.colorBlue",
  purple: "sender.colorPurple",
  pink: "sender.colorPink",
};

/** The message key of a palette entry's label, so the menu localises. */
export const senderColorLabelKey = (color: SenderColor): MessageKey => LABEL_KEYS[color];

/** Sets `--tag-color` on a tinted tag; nothing for an untinted one. */
export function senderColorStyle(value: string | null | undefined): CSSProperties | undefined {
  const color = senderColor(value);
  return color ? ({ "--tag-color": senderColorValue(color) } as CSSProperties) : undefined;
}
