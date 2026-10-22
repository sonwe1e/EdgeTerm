import { openUrl } from "@tauri-apps/plugin-opener";
import { type IMarker, type ITheme } from "@xterm/xterm";
import type { CommandSuggestion } from "./history";
import { IS_MAC } from "./platform";
import type { FindColors } from "./terminalFind";
import type { ThemeMode } from "./types";

export type GutterMode = "off" | "line" | "time" | "both";

/**
 * What a right click in the terminal does, when no program has taken over
 * the mouse. `menu` opens the app's context menu (the word under the
 * pointer is selected first, as in VS Code); `copyPaste` is the Windows
 * console convention — copy the selection if there is one, otherwise paste,
 * or with Copy on Select, which has copied it already, always paste (PuTTY).
 * macOS is always `menu`; the setting is Windows / Linux only.
 */
export type RightClickAction = "menu" | "copyPaste";

/** The cursor's shape; `cursorBlink` in the store says whether it blinks. */
export type CursorStyle = "block" | "underline" | "bar";

/** The xterm-owned inputs to a gutter paint; see `gutterPainted`. */
export type GutterView = {
  viewportY: number;
  cursorIndex: number;
  contentEnd: number;
  rows: number;
  alternate: boolean;
};

export type PaintRecord = { signature: number; cursor: boolean };

/**
 * How many terminals hold a WebGL renderer at once, most recently shown
 * first. WebKit allows 16 live WebGL contexts per page and, on the 17th,
 * takes the oldest one away; with one context per tab, opening enough tabs
 * stranded the earliest ones on the DOM renderer for good, where a
 * selection drag crawls (issue #14). A hidden tab has no use for the fast
 * renderer and every context pins a window-sized GPU surface, so the least
 * recently shown terminals give theirs up and load it again when shown.
 * Six covers the tabs someone actually cycles through, keeps GPU memory to
 * a few hundred megabytes and stays well clear of the limit.
 */
export const WEBGL_MAX_TERMINALS = 6;

/**
 * A lost context (WKWebView reclaims them under memory pressure or after a
 * long stay in the background) is recreated after a pause, a few times per
 * window at most; a GPU that keeps dropping it leaves the terminal on the
 * DOM renderer. Losses further apart than the window are separate incidents
 * with a fresh budget.
 */
export const WEBGL_RECOVERY_DELAY_MS = 2000;

export const WEBGL_RECOVERY_LIMIT = 3;

export const WEBGL_RECOVERY_WINDOW_MS = 60_000;

/** Terminals holding a WebGL renderer, most recently shown first. */

/**
 * How long an agentic CLI has to stay silent before its turn counts as
 * finished. Comfortably above the repaint rate of every one of them — they
 * animate a spinner and an elapsed-time counter for as long as they work,
 * tool calls included — and short enough that the tab reports back while the
 * answer is still on screen.
 */
export const AI_QUIET_MS = 2000;

/**
 * How many trimmed line times may sit in front of the live ones before the
 * array is copied down (see `lineTimesStart`). The copy moves the live
 * entries once every `LINE_TIME_SLACK` dropped lines, which on a full
 * 20 000-line scrollback works out at about five moves per line of output —
 * against 20 000 for splicing the front off on every one of them.
 */
export const LINE_TIME_SLACK = 4096;

/**
 * How long output must pause before the backlog pass colors the rows a
 * flood scrolled past (see `scheduleBacklog`), and how long one slice of
 * that pass may run before yielding to input and rendering.
 */
export const BACKLOG_QUIET_MS = 200;

export const BACKLOG_SLICE_MS = 8;

/**
 * Column changes can reflow scrollback. For normal buffers of at least
 * 200 lines, wait until the last width change has settled for this long.
 * Rows always update immediately, including during a diagonal drag;
 * Buffer._reflow returns when the column count is unchanged.
 */
export const FIT_SETTLE_MS = 100;

export const FIT_BUFFER_THRESHOLD = 200;

/**
 * Data xterm sends back on the terminal's own behalf rather than the user's:
 * answers to what a program asked it (device attributes, cursor position,
 * colors, mode state), focus notifications, and mouse tracking. They travel
 * the same path as keystrokes and must reach the program, but they say
 * nothing about what the user is doing — a TUI queries the terminal the
 * moment it starts and is told about every focus change, so counting them as
 * input opened an agentic CLI's turn for a tool nobody had typed into.
 */
export const TERMINAL_REPORT =
  /^(?:\x1b\[[?>]?[0-9;]*(?:[cnRtIO]|\$y)|\x1b\[<[0-9;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\][0-9]+;[\s\S]*?(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\)$/;

/** A working directory the shell announced with an OSC sequence. */
export interface ReportedCwd {
  /** Host part of an OSC 7 URL; "" when the sequence carried none. */
  host: string;
  path: string;
}

/** OSC 7 payload `file://host/path` (Terminal.app, WezTerm, fish, …). */
export function parseOsc7(data: string): ReportedCwd | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/s.exec(data);
  if (!match) return null;
  let path = match[2];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded (many prompt snippets write $PWD raw): as is.
  }
  return { host: match[1], path };
}

/** OSC 1337 payload `CurrentDir=path` (iTerm2 shell integration). */
export function parseOsc1337(data: string): ReportedCwd | null {
  const match = /^CurrentDir=(.+)$/s.exec(data);
  return match ? { host: "", path: match[1] } : null;
}

/** OSC 9 payload `9;path` (ConEmu / Windows Terminal), quotes optional. */
export function parseOsc9(data: string): ReportedCwd | null {
  if (!data.startsWith("9;")) return null;
  let path = data.slice(2);
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path ? { host: "", path } : null;
}

export function openTerminalWebLink(event: MouseEvent, uri: string) {
  // Opening terminal output on an unmodified click makes accidental launches
  // too easy. Match native terminal behavior on macOS and other platforms.
  if (!event.metaKey && !event.ctrlKey) return;

  event.preventDefault();
  void openUrl(uri).catch((error) => {
    console.error(`Failed to open terminal link ${uri}`, error);
  });
}

/** Plain Ctrl+letter: a control character to the shell (^C, ^W, ^D …). */
export const isControlLetter = (event: KeyboardEvent): boolean =>
  event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && /^[a-z]$/i.test(event.key);

/**
 * What Alt+arrow sends, by `event.key` in lower case: what xterm 5 sent for
 * the same keys (see the handler in the constructor).
 */
export const ALT_ARROW_SEQUENCES: Record<string, string | undefined> = IS_MAC
  ? { arrowleft: "\x1bb", arrowright: "\x1bf" }
  : {
      arrowleft: "\x1b[1;5D",
      arrowright: "\x1b[1;5C",
      arrowup: "\x1b[1;5A",
      arrowdown: "\x1b[1;5B",
    };

/**
 * VS Code's terminal palettes, one per theme, on the matching editor
 * backgrounds (kept in sync with --bg-terminal in styles.css). xterm.js
 * supplies the remaining 240 entries of the xterm-256color cube and grayscale
 * ramp automatically, and the enforced minimum contrast ratio keeps
 * low-contrast entries legible, as VS Code does.
 */
export const XTERM_THEMES: Record<ThemeMode, ITheme> = {
  dark: {
    background: "#1f1f1f",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1f1f1f",
    selectionBackground: "#264f78",
    selectionInactiveBackground: "#22374c",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    background: "#ffffff",
    foreground: "#3b3b3b",
    cursor: "#005fb8",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    selectionInactiveBackground: "#e5ebf1",
    black: "#000000",
    red: "#cd3131",
    green: "#107c10",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
  // serialX's own terminal palettes (its TerminalPalette::DARK / ::LIGHT).
  // Its plain red, green and yellow are the workbench's danger, success and
  // warning, so device colours and chrome agree; on white "bright" cannot
  // mean lighter or it would vanish, so the bright eight are the plain ones
  // lifted a little instead.
  "serialx-dark": {
    background: "#0b0d11",
    foreground: "#b2b8c4",
    cursor: "#8b87ff",
    cursorAccent: "#0b0d11",
    selectionBackground: "#34365e",
    selectionInactiveBackground: "#262a45",
    black: "#1b1f27",
    red: "#ef8a83",
    green: "#4fc38a",
    yellow: "#e0b070",
    blue: "#7aa2f7",
    magenta: "#c792ea",
    cyan: "#5fd1d8",
    white: "#b2b8c4",
    brightBlack: "#767d8c",
    brightRed: "#ff9f98",
    brightGreen: "#6ee0a2",
    brightYellow: "#f0c88a",
    brightBlue: "#99b8ff",
    brightMagenta: "#d8aaff",
    brightCyan: "#7fe6ec",
    brightWhite: "#edf0f5",
  },
  "serialx-light": {
    background: "#ffffff",
    foreground: "#3b3b42",
    cursor: "#5b57d8",
    cursorAccent: "#ffffff",
    selectionBackground: "#c4c2f2",
    selectionInactiveBackground: "#e2e1f8",
    black: "#17171b",
    red: "#cb4b40",
    green: "#2f8a5b",
    yellow: "#a8730f",
    blue: "#2f6fd6",
    magenta: "#8e44ad",
    cyan: "#1a8a96",
    white: "#3b3b42",
    brightBlack: "#86868f",
    brightRed: "#e0665b",
    brightGreen: "#3aa66f",
    brightYellow: "#c08a2a",
    brightBlue: "#4f89e8",
    brightMagenta: "#a85ec8",
    brightCyan: "#2aa3b1",
    brightWhite: "#5c5c66",
  },
};

/**
 * Find-in-buffer highlights, per theme. The Find in Selection range takes
 * the shade VS Code gives it (`editor.findRangeHighlightBackground`, laid
 * over each canvas), faint enough that the matches inside still stand out.
 */
const DARK_FIND_COLORS: FindColors = {
  match: "#623315",
  activeMatch: "#9e6a03",
  scope: "#2b2d30",
};

const LIGHT_FIND_COLORS: FindColors = {
  match: "#f5d3b0",
  activeMatch: "#a8ac94",
  scope: "#e9e9e9",
};

/** The find engine's highlight colors for the terminal's theme. */
export const FIND_COLORS: Record<ThemeMode, FindColors> = {
  dark: DARK_FIND_COLORS,
  light: LIGHT_FIND_COLORS,
  // The amber wash reads the same on serialX's two canvases; only the dark
  // one is deep enough to need its own range shade.
  "serialx-dark": { ...DARK_FIND_COLORS, scope: "#1b1e25" },
  "serialx-light": LIGHT_FIND_COLORS,
};

export interface Callbacks {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onStatus: (message: string, error?: boolean) => void;
  /**
   * Enter pressed while the session is dead and the terminal locked: the
   * one keystroke a dead session still answers, reconnecting it the way
   * WindTerm does.
   */
  onReconnect?: () => void;
  /** An executed command line, captured from the buffer after Enter. */
  onCommand: (command: string) => void;
  /**
   * Drives the background tab's running and unread-completion treatments.
   * `kind` says what the state is about: the submitted command, or one turn
   * of an agentic CLI that holds the terminal for a whole session.
   */
  onCommandState: (state: "idle" | "running" | "complete", kind: "command" | "ai") => void;
  /** Ranked history completions for the current input; [] when none. */
  suggest: (input: string) => CommandSuggestion[];
  /** Removes a command from the history behind `suggest`. */
  forgetSuggestion: (command: string) => void;
}

/**
 * Where the user's typing begins on the prompt line. Captured on the first
 * keystroke after a fresh prompt, before the shell has echoed anything, so the
 * cursor still sits at the prompt's end. The marker tracks the row across
 * scrolling; the column is fixed because prompts do not move.
 */
export interface InputAnchor {
  marker: IMarker;
  col: number;
}

export function formatTime(epochMs: number | undefined): string {
  if (!epochMs) return "[--:--:--.---]";
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${milliseconds}]`;
}
