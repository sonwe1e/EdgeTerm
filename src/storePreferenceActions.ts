import type { StateCreator } from "zustand";
import { DEFAULT_FILE_SORT, parseFileSort, saveFileSort } from "./fileSort";
import { commandHistory } from "./history";
import { parseLanguage, setCurrentLanguage } from "./i18n";
import { parseProgramClipboardMode } from "./osc52";
import {
  defaultPanelDocks,
  parsePanelDocks,
  movePanel as placePanel,
  samePanelDocks,
} from "./panelDock";
import { PANEL_PREFERENCE_KEYS, SORT_STORAGE_KEY } from "./persistKeys";
import { IS_MAC } from "./platform";
import {
  defaultShortcuts,
  parseShortcuts,
  setActiveShortcuts,
  shortcutOverrides,
} from "./shortcuts";
import {
  BUFFER_FONT_FAMILY_KEY,
  BUFFER_FONT_SIZE,
  BUFFER_FONT_SIZE_KEY,
  COPY_ON_SELECT_KEY,
  CURSOR_BLINK_KEY,
  CURSOR_STYLE_KEY,
  DEFAULT_PANELS,
  GPU_RENDERER_KEY,
  GUTTER_MODE_KEY,
  LANGUAGE_KEY,
  PANELS_KEY,
  PANEL_DOCKS_KEY,
  PANEL_FONT_FAMILY_KEY,
  PANEL_FONT_SIZE,
  PANEL_FONT_SIZE_KEY,
  PASTE_WARNING_KEY,
  PROGRAM_CLIPBOARD_KEY,
  RIGHT_CLICK_KEY,
  SHORTCUTS_KEY,
  SSH_AUTO_REUSE_KEY,
  SUGGESTIONS_KEY,
  TERMINAL_SCROLLBACK,
  TERMINAL_SCROLLBACK_KEY,
  THEME_KEY,
  defaultCopyOnSelect,
  defaultRightClickAction,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeScrollback,
  parseCursorStyle,
  parseGutterMode,
  parsePanels,
  parseRightClickAction,
  parseTheme,
  saveFontFamily,
  saveFontSize,
  savePanelDocks,
  savePanels,
  saveScrollback,
  saveSetting,
  saveShortcuts,
} from "./storePreferences";
import { AppSettings, AppStore } from "./storeTypes";

export const createPreferenceActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "togglePanel"
    | "movePanel"
    | "resetPanelLayout"
    | "setGutterMode"
    | "setFilerSort"
    | "setTheme"
    | "setLanguage"
    | "setPanelFontSize"
    | "setBufferFontSize"
    | "setPanelFontFamily"
    | "setBufferFontFamily"
    | "setSymbolFontFamilies"
    | "setSystemMonoFamily"
    | "setTerminalScrollback"
    | "setCursorStyle"
    | "setCursorBlink"
    | "setGpuRenderer"
    | "setSshAutoReuse"
    | "setPasteWarning"
    | "setCopyOnSelect"
    | "setPastePrompt"
    | "setProgramClipboard"
    | "setClipboardPrompt"
    | "setSuggestionsEnabled"
    | "setRightClickAction"
    | "setShortcuts"
    | "resetSettings"
    | "exportSettings"
    | "applySettings"
  >
> = (set, get) => ({
  togglePanel(panel) {
    const panels = get().panels;
    const nextPanels = { ...panels, [panel]: !panels[panel] };
    set({ panels: nextPanels });
    savePanels(nextPanels);
  },

  movePanel(panel, dock, before = null) {
    const { panelDocks, panels } = get();
    const nextDocks = placePanel(panelDocks, panel, dock, before);
    if (!samePanelDocks(panelDocks, nextDocks)) {
      set({ panelDocks: nextDocks });
      savePanelDocks(nextDocks);
    }
    if (!panels[panel]) get().togglePanel(panel);
  },

  resetPanelLayout() {
    const panelDocks = defaultPanelDocks();
    set({ panelDocks });
    savePanelDocks(panelDocks);
  },

  setGutterMode(mode) {
    set({ gutterMode: mode });
    try {
      localStorage.setItem(GUTTER_MODE_KEY, mode);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setFilerSort(sort) {
    set({ filerSort: sort });
    saveFileSort(sort);
  },

  setTheme(theme) {
    set({ theme });
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setLanguage(language) {
    if (parseLanguage(language) === null) return;
    set({ language });
    // Imperative status strings translate with the new language from here on.
    setCurrentLanguage(language);
    try {
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setPanelFontSize(size) {
    const panelFontSize = normalizeFontSize(size, PANEL_FONT_SIZE);
    set({ panelFontSize });
    saveFontSize(PANEL_FONT_SIZE_KEY, panelFontSize);
  },

  setBufferFontSize(size) {
    const bufferFontSize = normalizeFontSize(size, BUFFER_FONT_SIZE);
    set({ bufferFontSize });
    saveFontSize(BUFFER_FONT_SIZE_KEY, bufferFontSize);
  },

  setPanelFontFamily(family) {
    const panelFontFamily = normalizeFontFamily(family);
    set({ panelFontFamily });
    saveFontFamily(PANEL_FONT_FAMILY_KEY, panelFontFamily);
  },

  setBufferFontFamily(family) {
    const bufferFontFamily = normalizeFontFamily(family);
    set({ bufferFontFamily });
    saveFontFamily(BUFFER_FONT_FAMILY_KEY, bufferFontFamily);
  },

  setSymbolFontFamilies(families) {
    // The dialog rescans on every open; finding the same families keeps the
    // same array, so nothing keyed on it re-renders.
    const current = get().symbolFontFamilies;
    if (
      families.length === current.length &&
      families.every((name, index) => name === current[index])
    ) {
      return;
    }
    set({ symbolFontFamilies: families });
  },

  setSystemMonoFamily(systemMonoFamily) {
    set({ systemMonoFamily });
  },

  setTerminalScrollback(rows) {
    const terminalScrollback = normalizeScrollback(rows);
    set({ terminalScrollback });
    saveScrollback(terminalScrollback);
  },

  setCursorStyle(style) {
    const cursorStyle = parseCursorStyle(style) ?? "block";
    set({ cursorStyle });
    saveSetting(CURSOR_STYLE_KEY, cursorStyle);
  },

  setCursorBlink(blink) {
    set({ cursorBlink: blink });
    saveSetting(CURSOR_BLINK_KEY, blink ? "on" : "off");
  },

  setGpuRenderer(enabled) {
    set({ gpuRenderer: enabled });
    saveSetting(GPU_RENDERER_KEY, enabled ? "on" : "off");
  },

  setSshAutoReuse(enabled) {
    set({ sshAutoReuse: enabled });
    saveSetting(SSH_AUTO_REUSE_KEY, enabled ? "on" : "off");
  },

  setPasteWarning(enabled) {
    set({ pasteWarning: enabled });
    saveSetting(PASTE_WARNING_KEY, enabled ? "on" : "off");
  },

  setCopyOnSelect(enabled) {
    set({ copyOnSelect: enabled });
    saveSetting(COPY_ON_SELECT_KEY, enabled ? "on" : "off");
  },

  setPastePrompt(prompt) {
    set({ pastePrompt: prompt });
  },

  setProgramClipboard(mode) {
    set({ programClipboard: mode });
    saveSetting(PROGRAM_CLIPBOARD_KEY, mode);
  },

  setClipboardPrompt(prompt) {
    set({ clipboardPrompt: prompt });
  },

  setSuggestionsEnabled(enabled) {
    set({ suggestionsEnabled: enabled });
    // The history is only fetched once someone opts in (load() is a no-op on
    // repeat calls).
    if (enabled) commandHistory.load();
    try {
      localStorage.setItem(SUGGESTIONS_KEY, enabled ? "on" : "off");
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setRightClickAction(action) {
    // Nothing to choose on macOS; see loadRightClickAction.
    if (IS_MAC) return;
    set({ rightClickAction: action });
    try {
      localStorage.setItem(RIGHT_CLICK_KEY, action);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setShortcuts(bindings) {
    const shortcuts = { ...bindings };
    set({ shortcuts });
    setActiveShortcuts(shortcuts);
    saveShortcuts(shortcuts);
  },

  resetSettings() {
    const shortcuts = defaultShortcuts();
    setActiveShortcuts(shortcuts);
    set({
      shortcuts,
      panels: { ...DEFAULT_PANELS },
      panelDocks: defaultPanelDocks(),
      gutterMode: "both",
      filerSort: DEFAULT_FILE_SORT,
      theme: "dark",
      panelFontSize: PANEL_FONT_SIZE.default,
      bufferFontSize: BUFFER_FONT_SIZE.default,
      panelFontFamily: "",
      bufferFontFamily: "",
      terminalScrollback: TERMINAL_SCROLLBACK.default,
      cursorStyle: "block",
      cursorBlink: true,
      gpuRenderer: true,
      sshAutoReuse: true,
      suggestionsEnabled: false,
      pasteWarning: true,
      copyOnSelect: defaultCopyOnSelect(),
      programClipboard: "ask",
      rightClickAction: defaultRightClickAction(),
    });
    try {
      localStorage.removeItem(PANELS_KEY);
      localStorage.removeItem(PANEL_DOCKS_KEY);
      localStorage.removeItem(GUTTER_MODE_KEY);
      localStorage.removeItem(SORT_STORAGE_KEY);
      // Panel drafts re-read these values after the revision below changes.
      for (const key of PANEL_PREFERENCE_KEYS) localStorage.removeItem(key);
      localStorage.removeItem(THEME_KEY);
      localStorage.removeItem(PANEL_FONT_SIZE_KEY);
      localStorage.removeItem(BUFFER_FONT_SIZE_KEY);
      localStorage.removeItem(PANEL_FONT_FAMILY_KEY);
      localStorage.removeItem(BUFFER_FONT_FAMILY_KEY);
      localStorage.removeItem(TERMINAL_SCROLLBACK_KEY);
      localStorage.removeItem(CURSOR_STYLE_KEY);
      localStorage.removeItem(CURSOR_BLINK_KEY);
      localStorage.removeItem(GPU_RENDERER_KEY);
      localStorage.removeItem(SSH_AUTO_REUSE_KEY);
      localStorage.removeItem(SUGGESTIONS_KEY);
      localStorage.removeItem(PASTE_WARNING_KEY);
      localStorage.removeItem(COPY_ON_SELECT_KEY);
      localStorage.removeItem(PROGRAM_CLIPBOARD_KEY);
      localStorage.removeItem(RIGHT_CLICK_KEY);
      localStorage.removeItem(SHORTCUTS_KEY);
    } catch {
      // The defaults still apply for this run when storage is unavailable.
    }
    set({ panelPreferencesRevision: get().panelPreferencesRevision + 1 });
  },

  exportSettings() {
    const state = get();
    return {
      panels: { ...state.panels },
      panelDocks: {
        left: [...state.panelDocks.left],
        right: [...state.panelDocks.right],
        bottom: [...state.panelDocks.bottom],
      },
      gutterMode: state.gutterMode,
      filerSort: state.filerSort,
      preferences: Object.fromEntries(
        PANEL_PREFERENCE_KEYS.flatMap((key) => {
          const raw = localStorage.getItem(key);
          if (raw === null) return [];
          // Most preferences are JSON; a few (the save level) are plain
          // text. An unparseable value is carried as the string it is, and
          // written back verbatim on import.
          try {
            return [[key, JSON.parse(raw)]];
          } catch {
            return [[key, raw]];
          }
        }),
      ),
      theme: state.theme,
      language: state.language,
      panelFontSize: state.panelFontSize,
      bufferFontSize: state.bufferFontSize,
      panelFontFamily: state.panelFontFamily,
      bufferFontFamily: state.bufferFontFamily,
      terminalScrollback: state.terminalScrollback,
      cursorStyle: state.cursorStyle,
      cursorBlink: state.cursorBlink,
      gpuRenderer: state.gpuRenderer,
      sshAutoReuse: state.sshAutoReuse,
      suggestionsEnabled: state.suggestionsEnabled,
      pasteWarning: state.pasteWarning,
      copyOnSelect: state.copyOnSelect,
      programClipboard: state.programClipboard,
      rightClickAction: state.rightClickAction,
      shortcuts: shortcutOverrides(state.shortcuts),
    };
  },

  applySettings(settings) {
    if (!settings || typeof settings !== "object") return;
    const values = settings as Partial<Record<keyof AppSettings, unknown>>;
    const state = get();
    // Each setter validates and persists the way the menus do, so a partial
    // or hand-edited file can only ever change the fields it names.
    const theme = parseTheme(values.theme);
    if (theme) state.setTheme(theme);
    const language = parseLanguage(values.language);
    if (language) state.setLanguage(language);
    const gutterMode = parseGutterMode(values.gutterMode);
    if (gutterMode) state.setGutterMode(gutterMode);
    const filerSort = parseFileSort(values.filerSort);
    if (filerSort) state.setFilerSort(filerSort);
    const preferences = values.preferences;
    if (preferences && typeof preferences === "object" && !Array.isArray(preferences)) {
      // Only registered keys are written, verbatim: every owning module
      // validates and clamps its value when it loads it back.
      for (const [key, value] of Object.entries(preferences as Record<string, unknown>)) {
        if (!PANEL_PREFERENCE_KEYS.includes(key) || value === undefined) continue;
        try {
          localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
        } catch {
          // A blocked value is skipped; the rest of the import continues.
        }
      }
    }
    const panels = parsePanels(values.panels, state.panels);
    set({ panelPreferencesRevision: get().panelPreferencesRevision + 1 });
    if (panels) {
      set({ panels });
      savePanels(panels);
    }
    const panelDocks = parsePanelDocks(values.panelDocks);
    if (panelDocks) {
      set({ panelDocks });
      savePanelDocks(panelDocks);
    }
    if (typeof values.panelFontSize === "number") {
      state.setPanelFontSize(values.panelFontSize);
    }
    if (typeof values.bufferFontSize === "number") {
      state.setBufferFontSize(values.bufferFontSize);
    }
    if (typeof values.panelFontFamily === "string") {
      state.setPanelFontFamily(values.panelFontFamily);
    }
    if (typeof values.bufferFontFamily === "string") {
      state.setBufferFontFamily(values.bufferFontFamily);
    }
    if (typeof values.terminalScrollback === "number") {
      state.setTerminalScrollback(values.terminalScrollback);
    }
    const cursorStyle = parseCursorStyle(values.cursorStyle);
    if (cursorStyle) state.setCursorStyle(cursorStyle);
    if (typeof values.cursorBlink === "boolean") {
      state.setCursorBlink(values.cursorBlink);
    }
    if (typeof values.gpuRenderer === "boolean") {
      state.setGpuRenderer(values.gpuRenderer);
    }
    if (typeof values.sshAutoReuse === "boolean") state.setSshAutoReuse(values.sshAutoReuse);
    if (typeof values.suggestionsEnabled === "boolean") {
      state.setSuggestionsEnabled(values.suggestionsEnabled);
    }
    if (typeof values.pasteWarning === "boolean") {
      state.setPasteWarning(values.pasteWarning);
    }
    if (typeof values.copyOnSelect === "boolean") {
      state.setCopyOnSelect(values.copyOnSelect);
    }
    const programClipboard = parseProgramClipboardMode(values.programClipboard);
    if (programClipboard) state.setProgramClipboard(programClipboard);
    const rightClickAction = parseRightClickAction(values.rightClickAction);
    if (rightClickAction) state.setRightClickAction(rightClickAction);
    const shortcuts = parseShortcuts(values.shortcuts, state.shortcuts);
    if (shortcuts) state.setShortcuts(shortcuts);
  },
});
