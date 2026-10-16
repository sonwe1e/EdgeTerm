import { type FileSort } from "./fileSort";
import { type Language } from "./i18n";
import { type LayoutNode, type Side } from "./layout";
import { type ProgramClipboardMode } from "./osc52";
import { type PanelDock, type PanelDocks } from "./panelDock";
import { type ShortcutBindings } from "./shortcuts";
import type { CursorStyle, GutterMode, RightClickAction } from "./terminal";
import type {
  AuthPrompt,
  HostKeyChange,
  SessionGroup,
  SessionInfo,
  SessionProfile,
  SessionState,
  SshConfigPreview,
  ThemeMode,
} from "./types";

/** What a tab's activity treatment stands for; see `Tab.activityKind`. */
export type ActivityKind = "command" | "ai";

export interface Tab {
  info: SessionInfo;
  /**
   * The profile the tab was opened with, secrets included, so the session
   * can be reconnected in place. Kept in memory only.
   */
  profile: SessionProfile;
  /**
   * The number shown on the tab and bound to ⌘N / Alt+N. Fixed when the tab
   * opens (the lowest one no open tab holds) and kept for its lifetime, so
   * reordering or closing other tabs never renumbers it.
   */
  number: number;
  /**
   * Which open tab of the same session this is: 0 for the first, shown under
   * the bare name, then 1, 2, … shown as "name (1)", "name (2)". Like
   * `number` it is fixed when the tab opens (the lowest one no open tab of
   * the session holds) and never changes afterwards.
   */
  ordinal: number;
  state: SessionState;
  /**
   * Lifecycle of the command most recently submitted to this terminal.
   * `complete` is an unread notification: selecting the tab acknowledges it.
   */
  commandActivity: "idle" | "running" | "complete";
  /**
   * What that activity is about: the submitted command, or one turn of an
   * agentic CLI (Claude Code, Codex) that holds the terminal for a whole
   * session and is only worth reporting while the assistant works.
   */
  activityKind: ActivityKind;
  message?: string;
  cols: number;
  rows: number;
  /** The pane whose strip shows this tab; see `AppStore.panes`. */
  paneId: string;
}

/**
 * One region of the terminal area, with its own tab strip — VS Code's
 * editor group. The tree that lays the panes out is `AppStore.layout`.
 */
export interface Pane {
  id: string;
  /** The tab the pane shows; null only while the workspace has no tab. */
  activeTabId: string | null;
}

/** Where a tab being dragged would land if it were released now. */
export type DropTarget =
  | { paneId: string; zone: "strip"; index: number }
  | { paneId: string; zone: "center" | Side };

/** A refused SSH host key, kept until the user accepts it or gives up. */
export interface HostKeyPrompt {
  sessionId: string;
  /** The profile to reconnect with, secrets included. */
  profile: SessionProfile;
  change: HostKeyChange;
}

/**
 * A paste waiting to be confirmed, because it would submit more than one
 * command; see `TerminalController.paste`.
 */
export interface PastePrompt {
  sessionId: string;
  text: string;
}

/**
 * A program's OSC 52 write waiting for the user's yes; see
 * `TerminalController.programClipboardWrite`.
 */
export interface ClipboardPrompt {
  sessionId: string;
  text: string;
}

export type PanelName = "filer" | "sessions" | "sender";

/**
 * The preferences a data export carries (Session → Export Data…). Everything
 * here lives in localStorage; saved sessions and Sender tags come from the
 * backend instead.
 */
export interface AppSettings {
  panels: Record<PanelName, boolean>;
  /** Which dock each panel sits in, and in what order; see panelDock.ts. */
  panelDocks: PanelDocks;
  gutterMode: GutterMode;
  theme: ThemeMode;
  /** Interface language; see i18n.ts. */
  language: Language;
  panelFontSize: number;
  bufferFontSize: number;
  /** Interface font family; empty means the platform default stack. */
  panelFontFamily: string;
  /** Terminal font family; empty means the platform default stack. */
  bufferFontFamily: string;
  terminalScrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Whether the terminal renders on the GPU (WebGL) or the DOM. */
  gpuRenderer: boolean;
  sshAutoReuse: boolean;
  suggestionsEnabled: boolean;
  /** Confirm a paste that would submit more than one command. */
  pasteWarning: boolean;
  /** Put a mouse selection on the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  /** What a program's OSC 52 clipboard write does. */
  programClipboard: ProgramClipboardMode;
  /** Windows / Linux only; macOS always opens the menu. */
  rightClickAction: RightClickAction;
  /** Only the key bindings that differ from the platform defaults. */
  shortcuts: Partial<ShortcutBindings>;
  /** Column order of the Filer and dual-pane file lists; see fileSort.ts. */
  filerSort: FileSort;
  /**
   * Raw persisted panel preferences, keyed by their registered localStorage
   * keys (see persistKeys.ts). Their owning modules validate and clamp on
   * every load, so the file carries the stored values verbatim.
   */
  preferences: Record<string, unknown>;
}

export interface AppStore {
  profiles: SessionProfile[];
  /** User-defined folders of the Session panel; see `SessionGroup`. */
  groups: SessionGroup[];
  tabs: Tab[];
  /** The focused tab: the active tab of the active pane. */
  activeId: string | null;
  /**
   * The panes the terminal area is split into and the tree that lays them
   * out (see layout.ts). There is always at least one pane; a pane whose
   * last tab leaves folds away unless it is the only one.
   */
  panes: Pane[];
  layout: LayoutNode;
  activePaneId: string;
  /** A tab being dragged between strips, and where it would land. */
  draggingTabId: string | null;
  /** Re-read panel edit state after settings import/reset, even while mounted. */
  panelPreferencesRevision: number;
  dropTarget: DropTarget | null;
  gutterMode: GutterMode;
  /**
   * The column order of the Filer and the dual-pane browsers, shared so the
   * three lists follow one choice (see `setFilerSort`).
   */
  filerSort: FileSort;
  theme: ThemeMode;
  /** Interface language; drives every `t(...)` in the frontend. */
  language: Language;
  panelFontSize: number;
  bufferFontSize: number;
  panelFontFamily: string;
  bufferFontFamily: string;
  /**
   * Installed families the terminal stack falls back to for Nerd Font icons
   * (see `symbolFallbacks`). Read off the machine after start-up, never
   * saved or exported: another machine has its own fonts.
   */
  symbolFontFamilies: string[];
  /**
   * The face fontconfig resolves `monospace` to, which the Linux terminal
   * stack names outright (see `fontStack`); empty elsewhere. Asked at
   * start-up, never saved.
   */
  systemMonoFamily: string;
  terminalScrollback: number;
  /** The terminal cursor's shape and whether it blinks. */
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Whether the terminal renders on the GPU (WebGL) or the DOM. */
  gpuRenderer: boolean;
  sshAutoReuse: boolean;
  /** Command history recording + fish-style inline suggestions. */
  suggestionsEnabled: boolean;
  /** Whether a multi-line paste is confirmed first; see `pastePrompt`. */
  pasteWarning: boolean;
  /** Whether a mouse selection is copied without a Copy; see the terminal. */
  copyOnSelect: boolean;
  /** The paste waiting for the user's yes, or null. */
  pastePrompt: PastePrompt | null;
  /** Whether programs may set the clipboard with OSC 52; see osc52.ts. */
  programClipboard: ProgramClipboardMode;
  /** A program's clipboard write waiting for the user's yes, or null. */
  clipboardPrompt: ClipboardPrompt | null;
  /** What a right click in the terminal does; see `RightClickAction`. */
  rightClickAction: RightClickAction;
  /** The chord each app command answers; see `shortcuts.ts`. */
  shortcuts: ShortcutBindings;
  panels: Record<PanelName, boolean>;
  panelDocks: PanelDocks;
  status: string;
  error: string | null;
  errorSessionId: string | null;
  /**
   * A refused SSH host key awaiting the user's decision. It lives in the
   * store so the dialog is shown from App no matter which UI started the
   * connection.
   */
  hostKeyPrompt: HostKeyPrompt | null;
  /** The OpenSSH config being imported, while its chooser is open. */
  sshConfigImport: SshConfigPreview | null;
  /**
   * Verification challenges from servers still authenticating a session (an
   * MFA code, a push confirmation). Each is a round the connection is
   * blocked on, so they queue: the oldest is shown and the rest wait.
   */
  authPrompts: AuthPrompt[];
  /**
   * Ids of live tabs whose close is waiting for the user's confirmation.
   * Kept in the store so every close entry point (tab ✕, menu, ⌘W, the
   * strip's close-others commands) funnels into the one dialog rendered by
   * App.
   */
  closePrompt: string[] | null;
  /**
   * A directory the Filer was asked to show (⌘J / "Reveal Working Directory
   * in Filer"). `token` tells a repeat request for the same path apart from
   * the last one; `sessionId` lets the panel drop a request that resolved
   * after the user had switched to another tab.
   */
  filerTarget: { sessionId: string; path: string; token: number } | null;
  /**
   * Bumped whenever saved Sender tags change outside the Sender panel (a data
   * import, a deleted profile or group moving their scoped commands), so the
   * panel reloads its library.
   */
  senderLibraryVersion: number;

  /** Fetches saved profiles and their groups together. */
  loadProfiles: () => Promise<void>;
  upsertProfile: (profile: SessionProfile) => Promise<SessionProfile>;
  /** Saves a copy of a profile right after it; resolves to the copy. */
  duplicateProfile: (id: string) => Promise<SessionProfile>;
  /** Deletes a saved profile with everything that belongs to it. */
  removeProfile: (id: string) => Promise<void>;
  /** Moves a saved profile into a group (null = its kind's root). */
  moveProfileToGroup: (id: string, groupId: string | null) => Promise<void>;

  upsertGroup: (group: SessionGroup) => Promise<SessionGroup>;
  /**
   * Deletes a group with everything in it (subgroups, their sessions and
   * scoped Sender commands); profiles are reloaded to drop the removed ones.
   */
  removeGroup: (id: string) => Promise<void>;

  /** Opens a tab in the active pane and focuses it. */
  addTab: (info: SessionInfo, profile: SessionProfile, state?: SessionState) => void;
  updateTabInfo: (id: string, info: SessionInfo) => void;
  /**
   * Replaces a tab's own copy of the profile, for work that changes the
   * login it dials with (e.g. the public-key setup); without this a
   * reconnect would keep using the profile the tab was opened with.
   */
  updateTabProfile: (id: string, profile: SessionProfile) => void;
  closeTab: (id: string) => Promise<void>;
  /**
   * Closes a tab, asking first while its session is still connecting or
   * connected. Tabs that already ended (closed / error) have nothing left to
   * lose and close immediately.
   */
  requestCloseTab: (id: string) => void;
  /** `requestCloseTab` for several tabs, behind a single confirmation. */
  requestCloseTabs: (ids: string[]) => void;
  setClosePrompt: (ids: string[] | null) => void;
  /** Shows a tab in its pane and focuses it, making that pane the active one. */
  setActive: (id: string) => void;
  /** Focuses a pane: the tab it shows becomes the active tab. */
  setActivePane: (paneId: string) => void;
  /** Steps through the active pane's tabs. */
  activateAdjacentTab: (direction: -1 | 1) => void;
  /** Steps through the panes in reading order. */
  activateAdjacentPane: (direction: -1 | 1) => void;
  /**
   * Moves a tab to `index` counted over the other tabs of its pane, i.e. its
   * final position in the strip. Out-of-range indexes clamp to the ends.
   */
  moveTab: (id: string, index: number) => void;
  /**
   * Moves a tab into another pane, at `index` in that strip, and focuses it
   * there. The pane it leaves folds away when that was its last tab.
   */
  moveTabToPane: (id: string, paneId: string, index: number) => void;
  /**
   * Opens a new pane beside `paneId`, on the given side, and makes it the
   * active one; with `tabId` that tab moves into it, otherwise the pane is
   * empty until the caller opens a session in it. Returns the pane the
   * caller should now use: the new one, or `paneId` itself when the split
   * would only have moved a lone tab out of its own pane and folded that
   * pane away again.
   */
  splitPane: (paneId: string, side: Side, tabId?: string) => string;
  /** Drags a boundary between panes; the arguments are `resizeSplit`'s. */
  resizeLayout: (path: number[], index: number, delta: number, minSize: number) => void;
  /** Publishes a tab drag so every strip and pane can draw its part of it. */
  setTabDrag: (draggingTabId: string | null, dropTarget?: DropTarget | null) => void;

  applyState: (id: string, state: SessionState, message?: string) => void;
  /** Records a command, or an agentic CLI's turn, starting in a terminal. */
  markCommandStarted: (id: string, kind?: ActivityKind) => void;
  /** Leaves an unread completion on a background tab until it is selected. */
  markCommandCompleted: (id: string, kind?: ActivityKind) => void;
  /** Clears activity when a submitted write failed before reaching the shell. */
  clearCommandActivity: (id: string) => void;
  setSize: (id: string, cols: number, rows: number) => void;

  togglePanel: (panel: PanelName) => void;
  /**
   * Docks `panel` in `dock` in front of `before` (last when null) and shows
   * it: picking a place for a hidden panel means the user wants to see it.
   */
  movePanel: (panel: PanelName, dock: PanelDock, before?: PanelName | null) => void;
  resetPanelLayout: () => void;
  setGutterMode: (mode: GutterMode) => void;
  /** One column order shared by the Filer and both dual-pane browsers. */
  setFilerSort: (sort: FileSort) => void;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (language: Language) => void;
  setPanelFontSize: (size: number) => void;
  setBufferFontSize: (size: number) => void;
  setPanelFontFamily: (family: string) => void;
  setBufferFontFamily: (family: string) => void;
  setSymbolFontFamilies: (families: string[]) => void;
  setSystemMonoFamily: (family: string) => void;
  setTerminalScrollback: (rows: number) => void;
  setCursorStyle: (style: CursorStyle) => void;
  setCursorBlink: (blink: boolean) => void;
  setGpuRenderer: (enabled: boolean) => void;
  setSshAutoReuse: (enabled: boolean) => void;
  setSuggestionsEnabled: (enabled: boolean) => void;
  setPasteWarning: (enabled: boolean) => void;
  setPastePrompt: (prompt: PastePrompt | null) => void;
  setCopyOnSelect: (enabled: boolean) => void;
  setProgramClipboard: (mode: ProgramClipboardMode) => void;
  setClipboardPrompt: (prompt: ClipboardPrompt | null) => void;
  setRightClickAction: (action: RightClickAction) => void;
  setShortcuts: (bindings: ShortcutBindings) => void;
  resetSettings: () => void;
  /** The preferences a data export carries; see `applySettings`. */
  exportSettings: () => AppSettings;
  /**
   * Applies settings from a data import. Unknown or malformed fields are
   * ignored; fields the file does not mention keep their current value.
   */
  applySettings: (settings: unknown) => void;
  bumpSenderLibrary: () => void;
  setStatus: (status: string) => void;
  setError: (error: string | null, sessionId?: string) => void;
  setHostKeyPrompt: (prompt: HostKeyPrompt | null) => void;
  setSshConfigImport: (preview: SshConfigPreview | null) => void;
  addAuthPrompt: (prompt: AuthPrompt) => void;
  /** Drops a challenge the dialog has just answered. */
  clearAuthPrompt: (id: string) => void;
  /** Points the Filer at `path` for `sessionId`, showing the panel if hidden. */
  revealInFiler: (sessionId: string, path: string) => void;
}
