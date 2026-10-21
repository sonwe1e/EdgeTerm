import { detectLanguage, parseLanguage, setCurrentLanguage, type Language } from "./i18n";
import { parseProgramClipboardMode, type ProgramClipboardMode } from "./osc52";
import { defaultPanelDocks, parsePanelDocks, samePanelDocks, type PanelDocks } from "./panelDock";
import { HAS_TRAY, IS_MAC } from "./platform";
import {
  DEFAULT_SHORTCUTS,
  defaultShortcuts,
  parseShortcuts,
  setActiveShortcuts,
  shortcutOverrides,
  type ShortcutBindings,
} from "./shortcuts";
import { PanelName, type CloseAction } from "./storeTypes";
import type { CursorStyle, GutterMode, RightClickAction } from "./terminal";
import type { ThemeMode } from "./types";
import { THEME_MODES } from "./types";

/**
 * The panel chrome is set in this size, and the steps below it derive from
 * it with a floor (see --fs-* in foundation.styles.css). 10px is the
 * smallest base that still leaves a readable 8px step; the old 9px setting
 * rendered derived text at 7px, below any usable minimum.
 */
export const PANEL_FONT_SIZE = { min: 10, max: 18, default: 12 } as const;

export const BUFFER_FONT_SIZE = { min: 8, max: 32, default: 14 } as const;

export const TERMINAL_SCROLLBACK = {
  min: 0,
  max: 1_000_000,
  default: 10_000,
} as const;

/**
 * Rough memory a session holds for `lines` of history: xterm keeps three
 * 32-bit words per cell (CELL_SIZE in its BufferLine.ts) for every column of
 * every line. Per-line objects for wide or styled text come on top, so this
 * is a floor, shown to help choosing a number, not a measured figure.
 */
export const scrollbackMegabytes = (lines: number, cols = 200): number =>
  (Math.max(0, lines) * cols * 12) / (1024 * 1024);

// A fresh install shows only the session list; the Filer and Sender stay
// hidden until the user opens them from the View menu.
export const DEFAULT_PANELS: Record<PanelName, boolean> = {
  filer: false,
  sessions: true,
  sender: false,
};

export const PANEL_FONT_SIZE_KEY = "edgeterm.panelFontSize";

export const BUFFER_FONT_SIZE_KEY = "edgeterm.bufferFontSize";

export const PANEL_FONT_FAMILY_KEY = "edgeterm.panelFontFamily";

export const BUFFER_FONT_FAMILY_KEY = "edgeterm.bufferFontFamily";

export const TERMINAL_SCROLLBACK_KEY = "edgeterm.terminalScrollback";

export const GUTTER_MODE_KEY = "edgeterm.gutterMode";

export const PANELS_KEY = "edgeterm.panels";

export const PANEL_DOCKS_KEY = "edgeterm.panelDocks";

export const THEME_KEY = "edgeterm.theme";

export const SUGGESTIONS_KEY = "edgeterm.suggestions";

export const RIGHT_CLICK_KEY = "edgeterm.rightClick";

export const CLOSE_ACTION_KEY = "edgeterm.closeAction";

export const SHORTCUTS_KEY = "edgeterm.shortcuts";

export const CURSOR_STYLE_KEY = "edgeterm.cursorStyle";

export const CURSOR_BLINK_KEY = "edgeterm.cursorBlink";

export const GPU_RENDERER_KEY = "edgeterm.gpuRenderer";

export const SSH_AUTO_REUSE_KEY = "edgeterm.sshAutoReuse";

export const PASTE_WARNING_KEY = "edgeterm.pasteWarning";

export const COPY_ON_SELECT_KEY = "edgeterm.copyOnSelect";

export const PROGRAM_CLIPBOARD_KEY = "edgeterm.programClipboard";

export const LANGUAGE_KEY = "edgeterm.language";

// On by default: a paste that would run several commands is confirmed first
// (see `TerminalController.paste`). Only an explicit "off" turns it off, so a
// storage failure keeps the guard rather than dropping it.
export const loadPasteWarning = (): boolean => {
  try {
    return localStorage.getItem(PASTE_WARNING_KEY) !== "off";
  } catch {
    return true;
  }
};

// On by default on Windows / Linux, where the people who asked for it come
// from PuTTY, MobaXterm and Xshell and pair it with a right click that
// pastes (issue #66). Off on macOS: no Mac terminal but iTerm2 does it, and
// a clipboard replaced by merely selecting something surprises everyone
// who is not used to it.
export const defaultCopyOnSelect = (): boolean => !IS_MAC;

export const loadCopyOnSelect = (): boolean => {
  try {
    const stored = localStorage.getItem(COPY_ON_SELECT_KEY);
    return stored === "on" || stored === "off" ? stored === "on" : defaultCopyOnSelect();
  } catch {
    return defaultCopyOnSelect();
  }
};

// Ask by default (WindTerm): anything on the far end of a session can send
// OSC 52, and the clipboard is what the user pastes into the next shell.
export const loadProgramClipboard = (): ProgramClipboardMode => {
  try {
    return parseProgramClipboardMode(localStorage.getItem(PROGRAM_CLIPBOARD_KEY)) ?? "ask";
  } catch {
    return "ask";
  }
};

// The interface language: whatever the user chose, else the machine's (see
// detectLanguage). Kept in step with i18n.ts's module state so imperative
// status strings translate with it too.
export const loadLanguage = (): Language => {
  try {
    return parseLanguage(localStorage.getItem(LANGUAGE_KEY)) ?? detectLanguage();
  } catch {
    return detectLanguage();
  }
};

// Opt-in: command capture and the completion popup stay off until the user
// enables them in the Edit menu.
export const loadSuggestionsEnabled = (): boolean => {
  try {
    return localStorage.getItem(SUGGESTIONS_KEY) === "on";
  } catch {
    return false;
  }
};

// The parse* helpers validate a stored or imported value and return null for
// anything unknown, so both localStorage and a data file get the same checks.
export const parseTheme = (value: unknown): ThemeMode | null =>
  typeof value === "string" && THEME_MODES.includes(value as ThemeMode)
    ? (value as ThemeMode)
    : null;

export const parseGutterMode = (value: unknown): GutterMode | null =>
  value === "both" || value === "line" || value === "time" || value === "off" ? value : null;

export const parseRightClickAction = (value: unknown): RightClickAction | null =>
  value === "menu" || value === "copyPaste" ? value : null;

export const parseCloseAction = (value: unknown): CloseAction | null =>
  value === "ask" || value === "tray" || value === "exit" ? value : null;

/**
 * What closing the window does by default: ask every time. Hiding into the
 * tray is a deliberate opt-in (Windows / macOS; there is no tray icon on
 * Linux, so a stored "tray" degrades to "ask" there — see `HAS_TRAY`).
 */
export const loadCloseAction = (): CloseAction => {
  if (!HAS_TRAY) return "ask";
  try {
    return parseCloseAction(localStorage.getItem(CLOSE_ACTION_KEY)) ?? "ask";
  } catch {
    // Use the default when storage is unavailable.
    return "ask";
  }
};

/**
 * Where a right click goes by default: the console convention on Windows and
 * Linux — copy the selection, or paste when there is none — which is what
 * conhost, PuTTY, Xshell and SecureCRT all do, and the users of those arrive
 * expecting it (issue #63 reported it missing while it was only unset).
 * Edit → Right Click switches to the context menu.
 *
 * macOS terminals have no such convention, so the value is pinned to the menu
 * there: a stored or imported `copyPaste` never applies and the menu doesn't
 * offer it.
 */
export const defaultRightClickAction = (): RightClickAction => (IS_MAC ? "menu" : "copyPaste");

export const loadRightClickAction = (): RightClickAction => {
  if (IS_MAC) return "menu";
  try {
    return (
      parseRightClickAction(localStorage.getItem(RIGHT_CLICK_KEY)) ?? defaultRightClickAction()
    );
  } catch {
    // Use the default when storage is unavailable.
    return defaultRightClickAction();
  }
};

/** Fills fields missing from `value` with `base`; null if it is no object. */
export const parsePanels = (
  value: unknown,
  base: Record<PanelName, boolean>,
): Record<PanelName, boolean> | null => {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<Record<PanelName, unknown>>;
  return {
    filer: typeof parsed.filer === "boolean" ? parsed.filer : base.filer,
    sessions: typeof parsed.sessions === "boolean" ? parsed.sessions : base.sessions,
    sender: typeof parsed.sender === "boolean" ? parsed.sender : base.sender,
  };
};

export const loadTheme = (): ThemeMode => {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY)) ?? "dark";
  } catch {
    // Use the default when storage is unavailable.
    return "dark";
  }
};

export const loadPanels = (): Record<PanelName, boolean> => {
  try {
    const stored = localStorage.getItem(PANELS_KEY);
    if (stored) {
      const panels = parsePanels(JSON.parse(stored), DEFAULT_PANELS);
      if (panels) return panels;
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return { ...DEFAULT_PANELS };
};

export const savePanels = (panels: Record<PanelName, boolean>) => {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
};

export const loadPanelDocks = (): PanelDocks => {
  try {
    const stored = localStorage.getItem(PANEL_DOCKS_KEY);
    if (stored) {
      const docks = parsePanelDocks(JSON.parse(stored));
      if (docks) return docks;
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return defaultPanelDocks();
};

// Only a layout that differs from the default is stored, like the shortcut
// overrides, so a later change of the default reaches untouched installs.
export const savePanelDocks = (docks: PanelDocks) => {
  try {
    if (samePanelDocks(docks, defaultPanelDocks())) {
      localStorage.removeItem(PANEL_DOCKS_KEY);
    } else {
      localStorage.setItem(PANEL_DOCKS_KEY, JSON.stringify(docks));
    }
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
};

export const loadGutterMode = (): GutterMode => {
  try {
    return parseGutterMode(localStorage.getItem(GUTTER_MODE_KEY)) ?? "both";
  } catch {
    // Use the default when storage is unavailable.
    return "both";
  }
};

export const normalizeFontSize = (
  value: number,
  range: { min: number; max: number; default: number },
) => {
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
};

export const loadFontSize = (key: string, range: { min: number; max: number; default: number }) => {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? range.default : normalizeFontSize(Number(stored), range);
  } catch {
    return range.default;
  }
};

export const saveFontSize = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Font settings still work for this run when storage is unavailable.
  }
};

/**
 * A font family is stored as the bare family name, empty meaning "whatever
 * the platform default stack picks". Only the name is kept: the fallbacks
 * come from `fonts.ts`, which is the single place that knows them.
 */
export const normalizeFontFamily = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 100) : "";

export const loadFontFamily = (key: string): string => {
  try {
    return normalizeFontFamily(localStorage.getItem(key));
  } catch {
    return "";
  }
};

export const saveFontFamily = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Font settings still work for this run when storage is unavailable.
  }
};

export const normalizeScrollback = (value: number) => {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK.default;
  return Math.min(TERMINAL_SCROLLBACK.max, Math.max(TERMINAL_SCROLLBACK.min, Math.round(value)));
};

export const loadScrollback = () => {
  try {
    const stored = localStorage.getItem(TERMINAL_SCROLLBACK_KEY);
    return stored === null ? TERMINAL_SCROLLBACK.default : normalizeScrollback(Number(stored));
  } catch {
    return TERMINAL_SCROLLBACK.default;
  }
};

export const saveScrollback = (value: number) => {
  try {
    localStorage.setItem(TERMINAL_SCROLLBACK_KEY, String(value));
  } catch {
    // The setting still works for this run when storage is unavailable.
  }
};

export const parseCursorStyle = (value: unknown): CursorStyle | null =>
  value === "block" || value === "underline" || value === "bar" ? value : null;

export const loadCursorStyle = (): CursorStyle => {
  try {
    return parseCursorStyle(localStorage.getItem(CURSOR_STYLE_KEY)) ?? "block";
  } catch {
    return "block";
  }
};

// Stored as "on" / "off" like the other switches; absent means blinking, the
// default every session had before the setting existed.
export const loadCursorBlink = (): boolean => {
  try {
    return localStorage.getItem(CURSOR_BLINK_KEY) !== "off";
  } catch {
    return true;
  }
};

// Same shape: absent means the WebGL renderer, an explicit "off" the DOM one.
export const loadGpuRenderer = (): boolean => {
  try {
    return localStorage.getItem(GPU_RENDERER_KEY) !== "off";
  } catch {
    return true;
  }
};

export const loadSshAutoReuse = (): boolean => {
  try {
    return localStorage.getItem(SSH_AUTO_REUSE_KEY) !== "off";
  } catch {
    return true;
  }
};

export const saveSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
};

/**
 * Keyboard bindings are stored as the difference from this platform's
 * defaults, so a command the user never touched follows a later release's
 * default instead of being pinned to the one it shipped with.
 */
export const loadShortcuts = (): ShortcutBindings => {
  try {
    const stored = localStorage.getItem(SHORTCUTS_KEY);
    if (stored) {
      const bindings = parseShortcuts(JSON.parse(stored), DEFAULT_SHORTCUTS);
      if (bindings) return bindings;
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return defaultShortcuts();
};

export const saveShortcuts = (bindings: ShortcutBindings) => {
  try {
    const overrides = shortcutOverrides(bindings);
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(SHORTCUTS_KEY);
    } else {
      localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(overrides));
    }
  } catch {
    // The bindings still apply for this run when storage is unavailable.
  }
};

// The key matchers are not React and cannot subscribe, so the table in force
// is pushed into `shortcuts.ts` here and again from `setShortcuts`.
export const initialShortcuts = loadShortcuts();

setActiveShortcuts(initialShortcuts);

// Same push for localisation: imperative status strings (actions.ts, the
// store's own "Ready") translate with the language the interface opens in.
export const initialLanguage = loadLanguage();

setCurrentLanguage(initialLanguage);
