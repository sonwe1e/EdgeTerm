import { create } from "zustand";
import { ROOT_PANE_ID } from "./storeLayout";
import { createPreferenceActions } from "./storePreferenceActions";
import {
  BUFFER_FONT_FAMILY_KEY,
  BUFFER_FONT_SIZE,
  BUFFER_FONT_SIZE_KEY,
  PANEL_FONT_FAMILY_KEY,
  PANEL_FONT_SIZE,
  PANEL_FONT_SIZE_KEY,
  initialLanguage,
  initialShortcuts,
  loadCloseAction,
  loadCopyOnSelect,
  loadCursorBlink,
  loadCursorStyle,
  loadFontFamily,
  loadFontSize,
  loadGpuRenderer,
  loadGutterMode,
  loadPanelDocks,
  loadPanels,
  loadPasteWarning,
  loadProgramClipboard,
  loadRightClickAction,
  loadScrollback,
  loadSshAutoReuse,
  loadSuggestionsEnabled,
  loadTheme,
} from "./storePreferences";
import { createProfileActions } from "./storeProfileActions";
import { createPromptActions } from "./storePromptActions";
import { createTabActions } from "./storeTabActions";
import { AppStore, Tab } from "./storeTypes";
export { tabTitle } from "./storeLayout";
export {
  BUFFER_FONT_SIZE,
  PANEL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  loadTheme,
  scrollbackMegabytes,
} from "./storePreferences";
export type {
  ActivityKind,
  AppSettings,
  ClipboardPrompt,
  DropTarget,
  HostKeyPrompt,
  Pane,
  PanelName,
  PastePrompt,
  Tab,
} from "./storeTypes";

import { loadFileSort } from "./fileSort";
import { t } from "./i18n";
import { leaf } from "./layout";

export const useStore = create<AppStore>((set, get, store) => ({
  profiles: [],
  groups: [],
  tabs: [],
  activeId: null,
  gutterMode: loadGutterMode(),
  filerSort: loadFileSort(),
  panelPreferencesRevision: 0,
  theme: loadTheme(),
  language: initialLanguage,
  panelFontSize: loadFontSize(PANEL_FONT_SIZE_KEY, PANEL_FONT_SIZE),
  bufferFontSize: loadFontSize(BUFFER_FONT_SIZE_KEY, BUFFER_FONT_SIZE),
  panelFontFamily: loadFontFamily(PANEL_FONT_FAMILY_KEY),
  bufferFontFamily: loadFontFamily(BUFFER_FONT_FAMILY_KEY),
  symbolFontFamilies: [],
  systemMonoFamily: "",
  terminalScrollback: loadScrollback(),
  cursorStyle: loadCursorStyle(),
  cursorBlink: loadCursorBlink(),
  gpuRenderer: loadGpuRenderer(),
  sshAutoReuse: loadSshAutoReuse(),
  suggestionsEnabled: loadSuggestionsEnabled(),
  pasteWarning: loadPasteWarning(),
  copyOnSelect: loadCopyOnSelect(),
  pastePrompt: null,
  programClipboard: loadProgramClipboard(),
  clipboardPrompt: null,
  rightClickAction: loadRightClickAction(),
  closeAction: loadCloseAction(),
  shortcuts: initialShortcuts,
  panels: loadPanels(),
  panelDocks: loadPanelDocks(),
  status: t("status.ready"),
  error: null,
  errorSessionId: null,
  hostKeyPrompt: null,
  sshConfigImport: null,
  authPrompts: [],
  closePrompt: null,
  filerTarget: null,
  senderLibraryVersion: 0,

  panes: [{ id: ROOT_PANE_ID, activeTabId: null }],
  layout: leaf(ROOT_PANE_ID),
  activePaneId: ROOT_PANE_ID,
  draggingTabId: null,
  dropTarget: null,
  ...createProfileActions(set, get, store),

  ...createTabActions(set, get, store),

  ...createPreferenceActions(set, get, store),

  ...createPromptActions(set, get, store),
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
