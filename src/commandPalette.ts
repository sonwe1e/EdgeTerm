// The command palette: one searchable surface over everything the app can do
// right now. The catalogue is built from the same tables the menus, the
// shortcut settings and the session list already read, so a command cannot
// exist in the palette without existing in the app, and its label cannot drift
// from the menu's.
//
// This module is pure: it ranks text and describes commands, but it never
// touches React, the store or the DOM. The caller injects the actions, which
// is what lets the ranking be tested without a mounted app.

import { translate, type MessageKey, type Translate } from "./i18n";
import { COMMAND_RECENTS_KEY } from "./persistKeys";
import { loadIds, pushId, saveIds, type StorageLike } from "./recentIds";
import { quickConnectLabel, type QuickTarget } from "./quickConnect";
import {
  chordLabel,
  SHORTCUT_COMMANDS,
  shortcutHints,
  shortcutLabels,
  type AppShortcut,
  type ShortcutBindings,
  type ShortcutCommand,
} from "./shortcuts";
import { themeLabels, type ThemeMode } from "./types";

export type PaletteGroupId =
  | "actions"
  | "layout"
  | "panels"
  | "tabs"
  | "sessions"
  | "appearance"
  | "settings";

/** The order groups appear in, which is also the order of the unfiltered list. */
const PALETTE_GROUPS: readonly PaletteGroupId[] = [
  "actions",
  "layout",
  "panels",
  "tabs",
  "sessions",
  "appearance",
  "settings",
];

/** A group heading in the current language. */
export const paletteGroupLabels = (t: Translate): Record<PaletteGroupId, string> => ({
  actions: t("palette.group.actions"),
  layout: t("palette.group.layout"),
  panels: t("palette.group.panels"),
  tabs: t("palette.group.tabs"),
  sessions: t("palette.group.sessions"),
  appearance: t("palette.group.appearance"),
  settings: t("palette.group.settings"),
});

export interface PaletteCommand {
  /** Stable across sessions: recents and tests key on it. */
  id: string;
  /**
   * Run one frame after the palette closes. The close hands focus back to
   * whatever opened the palette, so a command whose whole job is to move focus
   * would be undone by that handback if it ran in the same tick.
   */
  runsAfterClose?: boolean;
  group: PaletteGroupId;
  label: string;
  /** A second line: what the command does, or where it goes. */
  hint?: string;
  /** Extra search terms that are not shown (English terms behind a Chinese label). */
  keywords: string[];
  /** The chord that runs it directly, already formatted for display. */
  chord?: string;
  run: () => void;
}

/** How many commands a recents list keeps; older entries fall off the end. */
export const RECENTS_LIMIT = 8;

/**
 * The command ids this machine ran last, newest first. Anything that is not a
 * string, repeats and unknown ids are dropped: the list is a preference, and a
 * preference from an older build must never break the palette.
 */
export function loadRecents(storage: StorageLike | null = null): string[] {
  return loadIds(COMMAND_RECENTS_KEY, RECENTS_LIMIT, storage ?? undefined);
}

/** Records a run at the front of the recents list. */
export function pushRecent(recents: readonly string[], id: string): string[] {
  return pushId(recents, id, RECENTS_LIMIT);
}

export function saveRecents(recents: readonly string[], storage: StorageLike | null = null): void {
  saveIds(recents, COMMAND_RECENTS_KEY, RECENTS_LIMIT, storage ?? undefined);
}

/** Case- and whitespace-insensitive form used for every comparison. */
export const normalizeQuery = (query: string): string =>
  query.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * How well one field matches the query. Higher is better; -1 means no match.
 * The ladder is exact, prefix, word start, substring, subsequence — the order
 * a reader expects a search box to answer in.
 */
export function fieldScore(field: string, query: string): number {
  if (!query) return 0;
  const text = field.toLowerCase();
  if (text === query) return 1000;
  if (text.startsWith(query)) return 900 - Math.min(50, text.length - query.length);
  const wordStart = new RegExp(`(^|[\\s._/-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(
    text,
  );
  if (wordStart) return 800 - Math.min(50, wordStart.index);
  const index = text.indexOf(query);
  if (index >= 0) return 700 - Math.min(100, index);
  // Subsequence: every query character in order, with a penalty for the gaps
  // that make a match feel accidental.
  let cursor = 0;
  let gaps = 0;
  let start = -1;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return -1;
    if (start < 0) start = found;
    else gaps += found - cursor;
    cursor = found + 1;
  }
  return 500 - Math.min(200, gaps * 4 + start);
}

/** The best score across the label, the search terms and the hint. */
export function commandScore(command: PaletteCommand, query: string): number {
  if (!query) return 0;
  let best = fieldScore(command.label, query);
  for (const keyword of command.keywords) {
    const score = fieldScore(keyword, query) - 40;
    if (score > best) best = score;
  }
  if (command.hint) {
    const score = fieldScore(command.hint, query) - 120;
    if (score > best) best = score;
  }
  return best;
}

/**
 * The catalogue filtered and ordered for a query. An empty query keeps the
 * catalogue's own order and does not reshuffle by recency: the first row is
 * then always the same command, which is what makes Enter feel predictable.
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  query: string,
  recents: readonly string[] = [],
): PaletteCommand[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...commands];
  const scored: {
    command: PaletteCommand;
    score: number;
    /** A recently-run command wins a tie, never a strictly better match. */
    recent: boolean;
    order: number;
  }[] = [];
  for (const [order, command] of commands.entries()) {
    const score = commandScore(command, normalized);
    if (score < 0) continue;
    scored.push({ command, score, recent: recents.includes(command.id), order });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      // Recency lifts a command among equally good matches; folding it into
      // the score let a prefix match overtake an exact one, and Enter then
      // ran the command whose label merely started with what was typed.
      Number(b.recent) - Number(a.recent) ||
      a.order - b.order,
  );
  return scored.map(({ command }) => command);
}

/**
 * Character ranges in `label` that matched the query, for bolding. A plain
 * substring wins; otherwise the subsequence's characters are marked one by one
 * and touching characters are merged into one range.
 */
export function matchRanges(label: string, query: string): [number, number][] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const lower = label.toLowerCase();
  const index = lower.indexOf(normalized);
  if (index >= 0) return [[index, index + normalized.length]];
  const ranges: [number, number][] = [];
  let cursor = 0;
  for (const character of normalized) {
    const found = lower.indexOf(character, cursor);
    if (found < 0) return [];
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    cursor = found + 1;
  }
  return ranges;
}

/** The shortest text that is worth a hint for a profile or a tab. */
const detailHint = (parts: (string | null | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part && part.trim())).join(" · ");

/** What the palette can do, injected by App so this module stays pure. */
/**
 * The row that offers to connect to what the reader just typed. It exists only
 * while the query parses as a target (see quickConnect.ts), so the palette's
 * search behaviour is unchanged for every other phrase.
 */
export function quickConnectCommand(
  target: QuickTarget,
  t: Translate,
  run: () => void,
  hint?: string,
): PaletteCommand {
  const label = quickConnectLabel(target);
  return {
    id: "connect:" + label,
    // Not a saved session: the row's own promise is that nothing is stored, so
    // filing it under "Saved sessions" contradicted the feature.
    group: "actions",
    label: t("palette.quickConnect", { target: label }),
    hint: hint ?? t("palette.quickConnectHint"),
    keywords: [target.host, "ssh", "connect", "quick", "host"],
    run,
  };
}

/**
 * Drops remembered targets that the field's own row already offers. Both rows
 * would be built from the same label and so the same id, which makes React keys
 * and the option ids collide; the field's row is the one Enter runs, so it stays.
 */
export function withoutTypedTarget(
  recent: readonly QuickTarget[],
  typed: string | null,
): QuickTarget[] {
  if (!typed) return [...recent];
  return recent.filter((target) => quickConnectLabel(target) !== typed);
}

export interface PaletteSources {
  /** Profile ids connected to on this machine, newest first. */
  recentProfiles?: readonly string[];
  t: Translate;
  shortcuts: ShortcutBindings;
  tabs: { id: string; title: string; hint: string }[];
  profiles: { id: string; name: string; hint: string }[];
  /** Saved commands, sent by name from the palette. */
  snippets?: { id: string; name: string; command: string }[];
  /** Recently run commands, newest first; empty when history is off. */
  history?: { command: string; host: string }[];
  theme: ThemeMode;
  actions: {
    runShortcut: (action: AppShortcut) => void;
    /** Answers a clipboard or selection command against the active terminal.
     *  `runShortcut` deliberately refuses these three - the terminal's own key
     *  filter answers them while it has focus, and the browser keeps its native
     *  editing keys elsewhere - so the palette rows need a way in of their own.
     */
    runTerminalCommand?: (command: "copy" | "paste" | "selectAll") => void;
    activateTab: (id: string) => void;
    connectProfile: (id: string) => void;
    setTheme: (theme: ThemeMode) => void;
    openDisplaySettings: () => void;
    openShortcutSettings: () => void;
    /** Opens the settings surface; the palette's "Settings" group is the way in. */
    openSettings: () => void;

    openAbout: () => void;
    checkForUpdates: () => void;
    importSshConfig?: () => void;
    sendSnippet?: (id: string) => void;
    /** Runs a command from the history list, through the same send funnel. */
    sendHistory?: (command: string) => void;
    saveLastCommandAsSnippet?: () => void;
    /** Opens the saved-command manager; the dialog has no chord of its own. */
    openSnippetsDialog?: () => void;
  };
}

/** Command ids keep their namespace, so a tab id can never shadow a command. */
export const shortcutCommandId = (id: ShortcutCommand): string => "shortcut:" + id;

/** Commands whose home is not the actions group. */
const GROUP_BY_COMMAND: Partial<Record<ShortcutCommand, PaletteGroupId>> = {
  prevTab: "layout",
  nextTab: "layout",
  splitRight: "layout",
  splitDown: "layout",
  prevPane: "layout",
  nextPane: "layout",
  focusRegion: "layout",
  panelSessions: "panels",
  panelFiler: "panels",
  panelSender: "panels",
};

/** camelCase command ids are themselves an English search term. */
const idWords = (id: string): string => id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * English text behind every localized label, so a Chinese interface can still
 * be driven with English words — and the same for the reverse, through the id.
 */
const englishLabel = (key: MessageKey): string => translate("en", key).toLowerCase();

/**
 * The chord display for a shortcut, read through the same formatter the menus
 * use, so a rebound key is shown instead of the default.
 */
const shortcutChord = (shortcuts: ShortcutBindings, id: ShortcutCommand): string => {
  const binding = shortcuts[id];
  return binding ? chordLabel(binding) : "";
};

/** The message key each shortcut command is labelled and hinted through. */
const shortcutKeys = (id: ShortcutCommand): { label: MessageKey; hint: MessageKey } => ({
  label: ("sc." + id + ".label") as MessageKey,
  hint: ("sc." + id + ".hint") as MessageKey,
});

/**
 * Everything the palette offers, in catalogue order. Session and tab commands
 * are captured from the caller's snapshot, so the palette lists what is open
 * right now rather than a stale copy.
 */
export function buildPaletteCommands(sources: PaletteSources): PaletteCommand[] {
  const { t, shortcuts, actions, theme } = sources;
  const labels = shortcutLabels(t);
  const hints = shortcutHints(t);
  const commands: PaletteCommand[] = [];

  // Saved commands are a list the reader wrote, so they are listed after the
  // fixed actions and searchable by their own text.
  for (const snippet of sources.snippets ?? []) {
    commands.push({
      id: "snippet:" + snippet.id,
      group: "actions",
      label: t("palette.sendSnippet", { name: snippet.name }),
      hint: snippet.command,
      keywords: ["snippet", snippet.name.toLowerCase(), snippet.command.toLowerCase()],
      run: () => actions.sendSnippet?.(snippet.id),
    });
  }
  if (actions.saveLastCommandAsSnippet) {
    commands.push({
      id: "snippet:save-last",
      group: "actions",
      label: t("palette.saveSnippet"),
      hint: t("palette.saveSnippetHint"),
      keywords: ["snippet", "save", "last command"],
      run: () => actions.saveLastCommandAsSnippet?.(),
    });
  }
  if (actions.openSnippetsDialog) {
    commands.push({
      id: "snippet:manage",
      group: "actions",
      label: t("palette.openSnippets"),
      hint: t("palette.openSnippetsHint"),
      keywords: ["snippet", "saved commands", "manage", "edit"],
      run: () => actions.openSnippetsDialog?.(),
    });
  }

  for (const { id, action } of SHORTCUT_COMMANDS) {
    // The palette does not list itself: running it would only reopen the
    // surface the reader is already in. Saved commands have their own row
    // above, so the shortcut is not listed a second time.
    if (id === "commandPalette" || id === "snippets") continue;
    const keys = shortcutKeys(id);
    // The three the keyboard deliberately leaves to the terminal's own key
    // filter: through the palette there is no filter to answer them, so the
    // row goes straight to the terminal the way the Edit menu does. Without
    // it the row closes the palette and does nothing at all.
    const terminalCommand = id === "copy" || id === "paste" || id === "selectAll" ? id : null;
    commands.push({
      id: shortcutCommandId(id),
      group: GROUP_BY_COMMAND[id] ?? "actions",
      label: labels[id],
      hint: hints[id],
      keywords: [englishLabel(keys.label), idWords(id)],
      chord: shortcutChord(shortcuts, id),
      // Moving focus is undone if it runs before the close returns focus.
      runsAfterClose: id === "focusRegion",
      run: () =>
        terminalCommand
          ? actions.runTerminalCommand?.(terminalCommand)
          : actions.runShortcut(action),
    });
  }

  for (const tab of sources.tabs) {
    commands.push({
      id: "tab:" + tab.id,
      group: "tabs",
      label: t("palette.tabItem", { title: tab.title }),
      hint: detailHint([tab.hint, t("palette.switchHint")]),
      keywords: [englishLabel("palette.tabItem"), tab.title, "tab", "switch"],
      run: () => actions.activateTab(tab.id),
    });
  }

  const recent = sources.recentProfiles ?? [];
  for (const profile of sources.profiles) {
    commands.push({
      id: "session:" + profile.id,
      group: "sessions",
      label: t("palette.sessionItem", { name: profile.name }),
      hint: detailHint([
        profile.hint,
        recent.includes(profile.id) ? t("palette.usedRecently") : undefined,
        t("palette.connectHint"),
      ]),
      keywords: [englishLabel("palette.sessionItem"), profile.name, "connect", "session"],
      run: () => actions.connectProfile(profile.id),
    });
  }

  const themes = themeLabels(t);
  for (const mode of Object.keys(themes) as ThemeMode[]) {
    const current = mode === theme;
    commands.push({
      id: "theme:" + mode,
      group: "appearance",
      label: t("palette.themeItem", { theme: themes[mode] }),
      hint: current ? t("palette.current") : undefined,
      keywords: [englishLabel("palette.themeItem"), "theme", mode, themes[mode].toLowerCase()],
      run: () => actions.setTheme(mode),
    });
  }

  const settings: {
    id: string;
    label: MessageKey;
    keywords: string[];
    /** Other words on that surface, in the interface's own language. */
    localized?: MessageKey[];
    run: () => void;
  }[] = [
    {
      id: "settings:all",
      label: "menu.allSettings",
      keywords: ["settings", "preferences", "language", "restore", "defaults", "export", "import"],
      // Language, restore-defaults and export/import live only on that surface.
      // In a translated interface their English keywords find nothing, so the
      // row carries the words the controls themselves use.
      localized: [
        "menu.language",
        "menu.restoreDefaultSettings",
        "menu.exportData",
        "menu.importData",
      ],
      run: actions.openSettings,
    },
    {
      id: "settings:display",
      label: "menu.displaySettings",
      keywords: ["display", "font", "size", "zoom", "appearance"],
      run: actions.openDisplaySettings,
    },
    {
      id: "settings:shortcuts",
      label: "menu.keyboardShortcuts",
      keywords: ["keyboard", "keys", "shortcut", "bindings"],
      run: actions.openShortcutSettings,
    },
    {
      id: "settings:about",
      label: "menu.about",
      keywords: ["about", "version", "license"],
      run: actions.openAbout,
    },
    {
      id: "settings:updates",
      label: "menu.checkForUpdates",
      keywords: ["update", "upgrade", "release", "download"],
      run: actions.checkForUpdates,
    },
  ];
  if (actions.importSshConfig) {
    settings.push({
      id: "settings:sshConfig",
      label: "menu.importOpenSshConfig",
      keywords: ["ssh", "config", "import", "host"],
      run: actions.importSshConfig,
    });
  }
  for (const entry of settings) {
    commands.push({
      id: entry.id,
      group: "settings",
      label: t(entry.label),
      keywords: [
        englishLabel(entry.label),
        ...entry.keywords,
        ...(entry.localized ?? []).map((key) => t(key)),
      ],
      run: entry.run,
    });
  }

  // History comes last so the unfiltered catalogue keeps the shape readers
  // know: the fixed actions first, then their own recent commands. Searching a
  // command's text still finds its row wherever it sits.
  for (const entry of sources.history ?? []) {
    commands.push({
      // Keyed by the command text, not by its position: the list re-sorts by
      // lastUsed on every read, so an index is a different command each time
      // - and the recency boost is persisted against the id, which would land
      // on whatever command had since slid into that slot.
      id: "history:" + entry.command,
      group: "actions",
      label: entry.command,
      hint: entry.host,
      keywords: ["history", "recent", entry.command.toLowerCase()],
      run: () => actions.sendHistory?.(entry.command),
    });
  }

  return commands;
}
export interface PaletteSection {
  id: PaletteGroupId;
  commands: PaletteCommand[];
}

/**
 * Groups ranked commands into sections. A group heading must appear once and
 * its rows must stay together — grouping by consecutive runs produced a second
 * "Actions" heading halfway down the list (and React saw duplicate section
 * keys). With an empty query the sections follow the catalogue's own order;
 * while searching they follow their best match, so relevance still leads.
 */
export function groupCommands(ranked: readonly PaletteCommand[], query: string): PaletteSection[] {
  const byGroup = new Map<PaletteGroupId, PaletteCommand[]>();
  const bestMatch = new Map<PaletteGroupId, number>();
  for (const [index, command] of ranked.entries()) {
    const list = byGroup.get(command.group);
    if (list) {
      list.push(command);
      continue;
    }
    byGroup.set(command.group, [command]);
    bestMatch.set(command.group, index);
  }
  const order = normalizeQuery(query)
    ? [...byGroup.keys()].sort((a, b) => (bestMatch.get(a) ?? 0) - (bestMatch.get(b) ?? 0))
    : PALETTE_GROUPS.filter((group) => byGroup.has(group));
  return order.map((id) => ({ id, commands: byGroup.get(id) ?? [] }));
}
