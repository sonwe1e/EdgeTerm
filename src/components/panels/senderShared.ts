import type { Translate } from "../../i18n";
import { type LineEnding, type SavedCommand } from "../../types";

export type Target = "current" | "all";

export type CommandContextMenu = {
  commandId: string;
  x: number;
  y: number;
};

export type CommandTooltip = {
  text: string;
  details: string;
  x: number;
  y: number;
};

/** What the inputs held before Edit replaced them, restored on Cancel. */
export type Draft = {
  text: string;
  tagName: string;
  ending: LineEnding;
};

/** The scope picker hanging off the Save / Update button. */
export type SavePicker = {
  x: number;
  y: number;
};

export type Editing = {
  command: SavedCommand;
  draft: Draft;
};

export const MAX_SAVED_COMMANDS = 1000;

export const COMMANDS_PER_PAGE = 24;

export const lineEndings = (t: Translate): [LineEnding, string][] => [
  ["none", t("sender.endingNone")],
  ["lf", "LF (\\n)"],
  ["crlf", "CRLF (\\r\\n)"],
];

export interface SenderPanelProps {
  compact: boolean;
  canCompact: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

/** `90` → "1 min 30 s", `3600` → "1 h". */
export function describeEvery(seconds: number): string {
  const parts: string[] = [];
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}
