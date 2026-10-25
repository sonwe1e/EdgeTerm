import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorText } from "../errorInfo";
import { GUIDE_URL } from "../distribution";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

import appIcon from "../../src-tauri/icons/32x32.png";
import { revealCwdInFiler, splitSession, toggleSessionConnection } from "../actions";
import { windowControl } from "../api";
import { exportAppData, importAppData, importSshConfig } from "../dataTransfer";
import { exportDiagnostics, openLogDirectory } from "../diagnostics";
import { commandHistory } from "../history";
import { LANGUAGES, LANGUAGE_LABELS, type Language } from "../i18n";
import { ask } from "../nativeDialog";
import { programClipboardLabels, type ProgramClipboardMode } from "../osc52";
import { DOCK_NAMES, dockLabels, dockOf, panelLabels, PANEL_NAMES } from "../panelDock";
import { HAS_TRAY, IS_MAC } from "../platform";
import { chordLabel, type ShortcutCommand } from "../shortcuts";
import { tabTitle, useActiveTab, useStore } from "../store";
import type { GutterMode, RightClickAction } from "../terminal";
import { getController } from "../terminalRegistry";
import type { CloseAction } from "../storeTypes";
import { THEME_MODES, themeLabels, type ThemeMode } from "../types";
import { useT } from "../useT";
import { hasLeading, MenuLeading, menuRole, type MenuMark } from "./ContextMenu";
import { Icon, type IconName } from "./icons";
import { SettingsDialog } from "./SettingsDialog";
import { submenuKey, useSubmenuHover } from "./submenuHover";

// The menubar is also the title bar: it is the window drag region and shares
// its row with the window controls, laid out like VS Code's custom title bar.
// - macOS: `titleBarStyle: "Overlay"` paints the traffic lights over our
//   content, so the bar leaves room for them (except in native fullscreen,
//   where macOS hides them).
// - Windows and Linux: the window is undecorated (see `create_main_window`
//   in lib.rs), so the bar follows VS Code's three-part layout: app icon and
//   menus on the left, the window title centred, minimize / maximize / close
//   on the right. Double-clicking the app icon closes the window (the
//   system-menu convention VS Code keeps on both platforms).
//
// The window title (`<session> - EdgeTerm`, VS Code's `<file> - <app>`
// shape) is also pushed to the OS so the taskbar / overview shows the same.

/** Track a boolean window property, re-reading it whenever the window resizes. */
function useWindowFlag(enabled: boolean, read: (win: TauriWindow) => Promise<boolean>): boolean {
  const [value, setValue] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      read(win)
        .then((next) => {
          if (!disposed) setValue(next);
        })
        .catch(() => {});
    };
    sync();
    win
      .onResized(sync)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, read]);
  return value;
}

const readFullscreen = (win: TauriWindow) => win.isFullscreen();
const readMaximized = (win: TauriWindow) => win.isMaximized();

// Windows / Linux: a press on the drag region does not hand the window to
// the OS straight away. `startDragging` gives the press to the OS move loop
// (`WM_NCLBUTTONDOWN` / `begin_move_drag`), which takes the mouse away from
// the webview until the button is released: the page never sees that mouseup,
// and on Windows the loop is entered through an IPC round trip, so a
// double-click's second press races it and is eaten by it whenever it lands
// first — the double-click then never reaches the page. Starting the drag
// only once the pointer has moved past a small threshold (as GTK header bars
// do) keeps plain clicks and double-clicks entirely inside the webview; the
// window only misses the first few pixels of travel, which is not visible.
const DRAG_THRESHOLD_PX = 4;

/** Start the OS window drag once the pointer moves past the threshold. */
function startDragOnMove(startX: number, startY: number): () => void {
  function stop() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
    window.removeEventListener("blur", stop);
  }
  function onMove(event: MouseEvent) {
    // A release the page never saw leaves `buttons` clear: the press is over.
    if (!(event.buttons & 1)) {
      stop();
      return;
    }
    if (
      Math.abs(event.clientX - startX) < DRAG_THRESHOLD_PX &&
      Math.abs(event.clientY - startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    stop();
    void getCurrentWindow()
      .startDragging()
      .catch(() => {});
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", stop);
  window.addEventListener("blur", stop);
  return stop;
}

interface WindowControl {
  label: string;
  icon: ReactElement;
  action: (win: TauriWindow) => Promise<void>;
  className?: string;
}

// Segoe Fluent-style caption glyphs on a 10px grid, drawn with 1px strokes.
const MINIMIZE_ICON = <path d="M0 5.5h10" />;
const MAXIMIZE_ICON = <rect x="0.5" y="0.5" width="9" height="9" />;
const RESTORE_ICON = (
  <>
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5v-2h7v7h-2" />
  </>
);
const CLOSE_ICON = <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />;

function WindowControls({ maximized }: { maximized: boolean }) {
  const t = useT();
  // Minimize / maximize go through `windowControl` rather than
  // `win.minimize()` / `win.toggleMaximize()`: on Windows the tao path behind
  // those refreshes the frame right after `ShowWindow`, which kills the DWM
  // grow / shrink animation on the undecorated window (elsewhere the command
  // just forwards to the window). The middle button toggles against the
  // window's real state rather than the cached `maximized` flag, so it is
  // right even if the flag lags. Close stays on the window API so the
  // close-requested hook still guards live sessions.
  const toggleMaximize = () => windowControl("toggle-maximize");
  const controls: WindowControl[] = [
    {
      label: t("window.minimize"),
      icon: MINIMIZE_ICON,
      action: () => windowControl("minimize"),
    },
    maximized
      ? { label: t("window.restoreDown"), icon: RESTORE_ICON, action: toggleMaximize }
      : { label: t("window.maximize"), icon: MAXIMIZE_ICON, action: toggleMaximize },
    {
      label: t("window.close"),
      icon: CLOSE_ICON,
      action: (win) => win.close(),
      className: " is-close",
    },
  ];
  return (
    <div className="window-controls" data-tauri-drag-region>
      {controls.map((control) => (
        <button
          key={control.label}
          className={`window-control${control.className ?? ""}`}
          title={control.label}
          aria-label={control.label}
          tabIndex={0}
          // Keep keyboard focus in the terminal on pointer press only: Tab
          // must still reach the caption buttons for keyboard users.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void control.action(getCurrentWindow()).catch(() => {})}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            {control.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

/** How a closing menu hands focus on. */
type MenuClose =
  /** Back to the menu's title (Escape). */
  | "title"
  /** Back to wherever focus was before the menu opened (a command ran). */
  | "previous"
  /** Back to the title, then let Tab continue from there (Tab out). */
  | "tab"
  /** Nowhere: let the browser move focus on by itself (a command closed it). */
  | "none";

/** All entry roles: one menu level is made of these, separators excluded. */
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * The entries of one menu level in DOM order. Nested submenu entries live in
 * the same subtree, so each candidate is kept only when its nearest
 * `.menu-dropdown` is the level being walked.
 */
function levelItems(level: HTMLElement | null): HTMLElement[] {
  if (!level) return [];
  return Array.from(level.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => item.closest(".menu-dropdown") === level,
  );
}

interface Entry {
  label: string;
  shortcut?: string;
  /** A Codicon in the leading column, before the label. */
  icon?: IconName;
  /** Marks the entry as a choice, and says whether it is the chosen one. */
  checked?: boolean;
  /** The control shape a checkable entry draws; a box by default. */
  mark?: MenuMark;
  action?: () => void;
  children?: (Entry | "separator")[];
}

interface Menu {
  title: string;
  entries: (Entry | "separator")[];
}

interface Props {
  onNewSession: () => void;
  onFind: () => void;
  onFindNext: () => void;
  onFontSettings: () => void;
  onKeyboardShortcuts: () => void;
  onCheckForUpdates: () => void;
  onAbout: () => void;
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
}

export function MenuBar(props: Props) {
  const [open, setOpen] = useState<string | null>(null);
  // The settings dialog, opened from the View menu and from Help's index
  // entry (PD-06). It lives here rather than in App because every surface it
  // reaches is already reachable from this component's props and stores.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // Stops the pending drag-threshold watch of the last drag-region press.
  const dragWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => dragWatch.current?.(), []);
  // Which item the next render should focus ("first" / "last"), or null when
  // a pointer opened the menu and must not move focus into it.
  const initialFocus = useRef<"first" | "last" | null>(null);
  // Where focus should return once a command has run — usually the terminal.
  const returnFocus = useRef<HTMLElement | null>(null);
  // What the window-level Alt / F10 handler sees; kept in a ref so that
  // handler does not have to be re-installed on every open / close.
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const titleRefs = useRef(new Map<string, HTMLButtonElement>());
  const macFullscreen = useWindowFlag(IS_MAC, readFullscreen);
  const maximized = useWindowFlag(!IS_MAC, readMaximized);

  const t = useT();
  const activeId = useStore((s) => s.activeId);
  const activeTab = useActiveTab();
  const activeState = activeTab?.state;
  const windowTitle = activeTab
    ? `${tabTitle(activeTab)}${IS_MAC ? " \u2014 " : " - "}EdgeTerm`
    : "EdgeTerm";
  useEffect(() => {
    getCurrentWindow()
      .setTitle(windowTitle)
      .catch(() => {});
  }, [windowTitle]);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const panelDocks = useStore((s) => s.panelDocks);
  const movePanel = useStore((s) => s.movePanel);
  const resetPanelLayout = useStore((s) => s.resetPanelLayout);
  const gutterMode = useStore((s) => s.gutterMode);
  const setGutterMode = useStore((s) => s.setGutterMode);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const setSuggestionsEnabled = useStore((s) => s.setSuggestionsEnabled);
  const rightClickAction = useStore((s) => s.rightClickAction);
  const setRightClickAction = useStore((s) => s.setRightClickAction);
  const closeAction = useStore((s) => s.closeAction);
  const setCloseAction = useStore((s) => s.setCloseAction);
  const pasteWarning = useStore((s) => s.pasteWarning);
  const copyOnSelect = useStore((s) => s.copyOnSelect);
  const setPasteWarning = useStore((s) => s.setPasteWarning);
  const setCopyOnSelect = useStore((s) => s.setCopyOnSelect);
  const programClipboard = useStore((s) => s.programClipboard);
  const setProgramClipboard = useStore((s) => s.setProgramClipboard);
  // The accelerators as the user has bound them (see shortcuts.ts); only
  // the tab-number keys are fixed.
  const shortcuts = useStore((s) => s.shortcuts);
  const accel = (command: ShortcutCommand) => chordLabel(shortcuts[command]);
  const setStatus = useStore((s) => s.setStatus);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);
  const activateAdjacentPane = useStore((s) => s.activateAdjacentPane);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      // Anywhere but a menu title or its dropdown: outside the bar, the bar's
      // blank drag area (window drag start), the app icon or window controls.
      if (!(target instanceof Element) || !target.closest(".menu-item-slot")) {
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  const withActive = (fn: (id: string) => void) => () => {
    if (activeId) fn(activeId);
  };

  // Display names for the enumerations the menus list, in the current language.
  const themes = themeLabels(t);
  const panelNames = panelLabels(t);
  const docks = dockLabels(t);
  const clipboards = programClipboardLabels(t);

  // One gutter mode and one theme are in force at a time: radios, not boxes.
  const gutterEntry = (label: string, mode: GutterMode): Entry => ({
    label,
    checked: gutterMode === mode,
    mark: "radio",
    action: () => setGutterMode(mode),
  });

  const themeEntry = (mode: ThemeMode): Entry => ({
    label: themes[mode],
    checked: theme === mode,
    mark: "radio",
    action: () => setTheme(mode),
  });

  const rightClickEntry = (label: string, action: RightClickAction): Entry => ({
    label,
    checked: rightClickAction === action,
    mark: "radio",
    action: () => setRightClickAction(action),
  });

  const closeEntry = (label: string, action: CloseAction): Entry => ({
    label,
    checked: closeAction === action,
    mark: "radio",
    action: () => setCloseAction(action),
  });

  // One radio group per panel: each sits in exactly one dock.
  const panelLayoutEntries = (): (Entry | "separator")[] => [
    ...PANEL_NAMES.flatMap((panel, index): (Entry | "separator")[] => [
      ...(index > 0 ? ["separator" as const] : []),
      ...DOCK_NAMES.map(
        (dock): Entry => ({
          label: t("menu.panelOnDock", {
            panel: panelNames[panel],
            dock: docks[dock],
          }),
          checked: dockOf(panelDocks, panel) === dock,
          mark: "radio",
          action: () => movePanel(panel, dock),
        }),
      ),
    ]),
    "separator",
    { label: t("menu.resetPanelLayout"), action: resetPanelLayout },
  ];

  const programClipboardEntry = (mode: ProgramClipboardMode): Entry => ({
    label: clipboards[mode],
    checked: programClipboard === mode,
    mark: "radio",
    action: () => setProgramClipboard(mode),
  });

  const languageEntry = (lang: Language): Entry => ({
    label: LANGUAGE_LABELS[lang],
    checked: language === lang,
    mark: "radio",
    action: () => setLanguage(lang),
  });

  // One entry mirrors the Session panel's power toggle: it names — and draws
  // — whichever side of the switch applies to the active session now. The
  // label and the icon are decided together so they cannot disagree.
  const switchSide: "cancel" | "reconnect" | "disconnect" =
    activeState === "connecting"
      ? "cancel"
      : activeState === "closed" || activeState === "error"
        ? "reconnect"
        : "disconnect";
  const connectionEntry: Entry = {
    label:
      switchSide === "cancel"
        ? t("menu.cancelConnection")
        : switchSide === "reconnect"
          ? t("menu.reconnectSession")
          : t("menu.disconnectSession"),
    icon:
      switchSide === "cancel"
        ? "close"
        : switchSide === "reconnect"
          ? "debug-restart"
          : "debug-disconnect",
    action: withActive(toggleSessionConnection),
  };

  const menus: Menu[] = [
    {
      title: t("menu.session"),
      entries: [
        {
          label: t("menu.newSession"),
          icon: "new-session",
          shortcut: accel("newSession"),
          action: props.onNewSession,
        },
        "separator",
        {
          label: t("menu.previousSession"),
          icon: "arrow-left",
          shortcut: accel("prevTab"),
          action: () => activateAdjacentTab(-1),
        },
        {
          label: t("menu.nextSession"),
          icon: "arrow-right",
          shortcut: accel("nextTab"),
          action: () => activateAdjacentTab(1),
        },
        {
          label: t("menu.previousPane"),
          icon: "arrow-up",
          shortcut: accel("prevPane"),
          action: () => activateAdjacentPane(-1),
        },
        {
          label: t("menu.nextPane"),
          icon: "arrow-down",
          shortcut: accel("nextPane"),
          action: () => activateAdjacentPane(1),
        },
        "separator",
        connectionEntry,
        {
          label: t("menu.closeSession"),
          icon: "close",
          shortcut: accel("closeSession"),
          action: withActive(requestCloseTab),
        },
        "separator",
        {
          label: t("menu.timestampLine"),
          icon: "clockface",
          children: [
            gutterEntry(t("menu.gutterBoth"), "both"),
            gutterEntry(t("menu.gutterLine"), "line"),
            gutterEntry(t("menu.gutterTime"), "time"),
            gutterEntry(t("menu.gutterOff"), "off"),
          ],
        },
        "separator",
        {
          label: t("menu.exportData"),
          icon: "export",
          action: () => void exportAppData(),
        },
        {
          label: t("menu.importData"),
          icon: "cloud-download",
          action: () => void importAppData(),
        },
        {
          label: t("menu.importOpenSshConfig"),
          icon: "server-environment",
          action: () => void importSshConfig(),
        },
      ],
    },
    {
      title: t("menu.edit"),
      entries: [
        {
          label: t("menu.copy"),
          icon: "copy",
          shortcut: accel("copy"),
          action: withActive((id) => getController(id)?.copySelection()),
        },
        {
          label: t("menu.paste"),
          icon: "clippy",
          shortcut: accel("paste"),
          action: withActive((id) => getController(id)?.pasteFromClipboard()),
        },
        {
          label: t("menu.selectAll"),
          icon: "list-selection",
          shortcut: accel("selectAll"),
          action: withActive((id) => getController(id)?.selectAll()),
        },
        "separator",
        {
          // The X11 / PuTTY habit: a selection is on the clipboard the
          // moment the mouse button comes up.
          label: t("menu.copyOnSelect"),
          checked: copyOnSelect,
          action: () => setCopyOnSelect(!copyOnSelect),
        },
        {
          // Every line of a paste after the first runs as its own command,
          // so a paste that holds several is confirmed first (issue #63).
          label: t("menu.warnMultiLinePaste"),
          checked: pasteWarning,
          action: () => setPasteWarning(!pasteWarning),
        },
        {
          // OSC 52: tmux, vim and TUI agents copy through the terminal
          // (issue #65). Reading the clipboard back is never allowed.
          label: t("menu.programsCanSetClipboard"),
          icon: "shield",
          children: [
            programClipboardEntry("ask"),
            programClipboardEntry("allow"),
            programClipboardEntry("deny"),
          ],
        },
        // Mouse copy / paste is a Windows / Linux choice; macOS terminals
        // always open the menu, so the submenu is left out there.
        ...(IS_MAC
          ? []
          : [
              "separator" as const,
              {
                label: t("menu.rightClick"),
                icon: "cursor" as const,
                children: [
                  rightClickEntry(t("menu.rightClickShowMenu"), "menu"),
                  // With Copy on Select the selection is copied already,
                  // so this mode only pastes (see TerminalPane).
                  rightClickEntry(
                    copyOnSelect ? t("menu.rightClickPaste") : t("menu.rightClickCopyOrPaste"),
                    "copyPaste",
                  ),
                ],
              },
            ]),
        // What the window ✕ does. The tray rides Windows / macOS only (see
        // HAS_TRAY); without it the choices degrade to close's old behaviour.
        ...(HAS_TRAY
          ? [
              "separator" as const,
              {
                label: t("menu.closeWindow"),
                children: [
                  closeEntry(t("menu.closeAsk"), "ask"),
                  closeEntry(t("menu.closeTray"), "tray"),
                  closeEntry(t("menu.closeExit"), "exit"),
                ],
              },
            ]
          : []),
        "separator",
        {
          label: t("menu.clearBuffer"),
          icon: "clear-all",
          shortcut: accel("clear"),
          action: withActive((id) => getController(id)?.clear()),
        },
        "separator",
        {
          label: t("menu.commandSuggestions"),
          checked: suggestionsEnabled,
          action: () => setSuggestionsEnabled(!suggestionsEnabled),
        },
        {
          label: t("menu.clearCommandHistory"),
          icon: "history",
          action: () => {
            void (async () => {
              const confirmed = await ask(t("confirm.clearCommandHistory"), {
                title: t("confirm.clearCommandHistoryTitle"),
                kind: "warning",
                okLabel: t("confirm.clear"),
                cancelLabel: t("common.cancel"),
              });
              if (!confirmed) return;
              try {
                await commandHistory.clear();
                setStatus(t("status.commandHistoryCleared"));
              } catch (error) {
                setStatus(t("status.commandHistoryClearFailed", { error: errorText(error) }));
              }
            })();
          },
        },
      ],
    },
    {
      title: t("menu.search"),
      entries: [
        {
          label: t("menu.find"),
          icon: "search",
          shortcut: accel("find"),
          action: props.onFind,
        },
        {
          label: t("menu.findNext"),
          icon: "arrow-down",
          shortcut: accel("findNext"),
          action: props.onFindNext,
        },
      ],
    },
    {
      title: t("menu.view"),
      entries: [
        {
          label: t("wb.title"),
          checked: props.workbenchOpen,
          action: props.onToggleWorkbench,
        },
        "separator",
        {
          label: t("menu.panelSessions"),
          shortcut: accel("panelSessions"),
          checked: panels.sessions,
          action: () => togglePanel("sessions"),
        },
        {
          label: t("menu.panelFiler"),
          shortcut: accel("panelFiler"),
          checked: panels.filer,
          action: () => togglePanel("filer"),
        },
        {
          label: t("menu.panelSender"),
          shortcut: accel("panelSender"),
          checked: panels.sender,
          action: () => togglePanel("sender"),
        },
        {
          label: t("menu.panelLayout"),
          // Not a layout *frame* glyph: in a menu whose column already holds
          // check boxes, a single outlined rectangle reads as one more box.
          // The four tiles say "arrangement" without borrowing that shape.
          icon: "multiple-windows",
          children: panelLayoutEntries(),
        },
        "separator",
        {
          // A split opens the active session's profile again beside it; see
          // splitSession.
          label: t("menu.splitRight"),
          icon: "split-horizontal",
          shortcut: accel("splitRight"),
          action: withActive((id) => void splitSession(id, "right")),
        },
        {
          label: t("menu.splitDown"),
          icon: "split-vertical",
          shortcut: accel("splitDown"),
          action: withActive((id) => void splitSession(id, "down")),
        },
        "separator",
        {
          label: t("menu.revealCwdInFiler"),
          icon: "folder-opened",
          shortcut: accel("revealCwd"),
          action: withActive((id) => void revealCwdInFiler(id)),
        },
        "separator",
        {
          label: t("menu.theme"),
          icon: "symbol-color",
          children: THEME_MODES.map(themeEntry),
        },
        "separator",
        {
          label: t("menu.displaySettings"),
          icon: "text-size",
          action: props.onFontSettings,
        },
        {
          label: t("menu.keyboardShortcuts"),
          icon: "keyboard",
          action: props.onKeyboardShortcuts,
        },
        {
          // The index the review asked for (PD-06): the preferences that
          // used to be scattered, gathered in one dialog.
          label: t("menu.settings"),
          icon: "settings-gear",
          action: () => setSettingsOpen(true),
        },
      ],
    },
    {
      title: t("menu.help"),
      entries: [
        {
          label: t("menu.tutorial"),
          icon: "book",
          action: () => {
            void openUrl(GUIDE_URL).catch((error) => {
              setStatus(t("status.tutorialOpenFailed", { error: errorText(error) }));
            });
          },
        },
        {
          label: t("menu.checkForUpdates"),
          icon: "refresh",
          action: props.onCheckForUpdates,
        },
        {
          label: t("menu.openLogDirectory"),
          icon: "folder-opened",
          action: () => void openLogDirectory(),
        },
        {
          label: t("menu.exportDiagnostics"),
          icon: "export",
          action: () => void exportDiagnostics(),
        },
        "separator",
        {
          // Restoring defaults moved into the settings dialog (PD-06), where
          // the confirmation can name what it clears; Help keeps one index
          // entry that opens it.
          label: t("menu.allSettings"),
          icon: "settings-gear",
          action: () => setSettingsOpen(true),
        },
        {
          label: t("menu.language"),
          icon: "globe",
          children: LANGUAGES.map(languageEntry),
        },
        "separator",
        { label: t("menu.about"), icon: "info", action: props.onAbout },
      ],
    },
  ];

  // --- menu keyboard model ---------------------------------------------------
  //
  // The menubar is a real menubar: Alt / F10 reach it from anywhere, the
  // titles move with the arrow keys, and each dropdown answers the menu keys.
  // Focus is handed back to the title on Escape (and to whatever had it
  // before when a command runs) so the terminal keeps typing focus.

  const focusTitle = useCallback((title: string) => {
    // The panel is gone from the DOM by the next frame; the title is not.
    requestAnimationFrame(() => titleRefs.current.get(title)?.focus());
  }, []);

  const closeMenu = useCallback(
    (mode: MenuClose) => {
      const title = open;
      setOpen(null);
      if (mode === "title") {
        if (title) focusTitle(title);
        return;
      }
      if (mode === "tab") {
        // Focus the title synchronously so the browser's default Tab
        // navigation starts from the bar, not from the button about to be
        // removed; the dropdown unmounts on the next render.
        if (title) titleRefs.current.get(title)?.focus();
        return;
      }
      if (mode === "previous") {
        const previous = returnFocus.current;
        if (previous?.isConnected) {
          previous.focus();
          return;
        }
      }
      // "none", or a previous target that is gone: leave focus to the
      // browser (Tab) or fall back to the title the menu came from.
      if (mode === "none") return;
      if (title) focusTitle(title);
    },
    [open, focusTitle],
  );

  const rememberFocus = useCallback(() => {
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
  }, []);

  /** Open `title`, focusing the first / last item (or nothing, leaving the title). */
  const openMenu = (title: string, focus: "first" | "last" | null) => {
    rememberFocus();
    initialFocus.current = focus;
    setOpen(title);
  };

  /** Keys on the title itself: move along the bar, or open the dropdown. */
  const onTitleKeyDown = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const menu = menus[index];
    const last = menus.length - 1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft": {
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next = menus[(index + step + menus.length) % menus.length];
        // Stepping along the bar opens the next menu and leaves focus on its
        // title, the way a native menubar does.
        rememberFocus();
        initialFocus.current = null;
        setOpen(next.title);
        titleRefs.current.get(next.title)?.focus();
        return;
      }
      case "Home":
      case "End": {
        event.preventDefault();
        const next = event.key === "Home" ? menus[0] : menus[last];
        titleRefs.current.get(next.title)?.focus();
        return;
      }
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const edge = event.key === "ArrowDown" ? "first" : "last";
        if (open === menu.title) {
          // The title of an open menu was reached again (arrow stepping):
          // step into the panel it already shows.
          const panel =
            event.currentTarget.parentElement?.querySelector<HTMLElement>(".menu-dropdown") ?? null;
          const items = levelItems(panel);
          (edge === "first" ? items[0] : items[items.length - 1])?.focus();
          return;
        }
        openMenu(menu.title, edge);
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        openMenu(menu.title, "first");
        return;
      }
      case "Escape": {
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu("title");
        return;
      }
      case "Tab": {
        // Let the browser carry focus out of the bar; the panel closes.
        if (open) setOpen(null);
        return;
      }
    }
  };

  // Escape closes a menu even when focus never entered it (a hover opened it
  // while the terminal kept focus).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu("title");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeMenu]);

  // Alt / F10 reach the menubar from wherever focus is. Alt counts only when
  // it is pressed and released on its own: Alt+F4 / Alt+letter belong to the
  // window and the shell. F10 is left to a handler that already claimed it
  // (the terminal takes its function keys on keydown).
  const firstTitle = menus[0]?.title ?? null;
  useEffect(() => {
    let altDown = false;
    let altChord = false;
    const toggle = () => {
      const current = openRef.current;
      if (current) {
        setOpen(null);
        focusTitle(current);
        return;
      }
      if (!firstTitle) return;
      rememberFocus();
      initialFocus.current = "first";
      setOpen(firstTitle);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("dialog[open]")) return;
      if (event.key === "Alt") {
        altDown = true;
        altChord = false;
        return;
      }
      if (altDown) altChord = true;
      if (
        event.key === "F10" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        toggle();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      // A dialog owns the keyboard while it is open; Alt belongs to it (and
      // to the system), not to the menubar underneath.
      if (document.activeElement?.closest("dialog[open]")) {
        altDown = false;
        altChord = false;
        return;
      }
      const plain = altDown && !altChord && !event.ctrlKey && !event.shiftKey && !event.metaKey;
      altDown = false;
      altChord = false;
      if (!plain) return;
      event.preventDefault();
      toggle();
    };
    const reset = () => {
      altDown = false;
      altChord = false;
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", reset);
    };
  }, [firstTitle, focusTitle, rememberFocus]);

  // A double-click on the drag region maximizes / restores (on the app icon
  // it closes the window instead, as in VS Code); it is taken here on the
  // same elements Tauri's injected drag script treats as the drag region
  // (everything carrying the attribute, not the menu titles) and stopped
  // before it reaches the script's document listener, which would otherwise
  // toggle through the animation-less tao path on Windows. A single press is
  // handled per platform: on macOS it falls through to the script, which
  // starts the native drag from the mousedown itself; on Windows / Linux it
  // is stopped as well and the drag starts from `startDragOnMove` once the
  // pointer actually moves (see the note above it).
  const onDragRegionMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (!event.target.hasAttribute("data-tauri-drag-region")) return;
    // The document-level dismiss listener never sees this press (stopped
    // here, or by the script's `stopImmediatePropagation` on macOS).
    setOpen(null);
    dragWatch.current?.();
    dragWatch.current = null;
    if (event.detail === 2) {
      event.preventDefault();
      event.stopPropagation();
      if (event.target.classList.contains("menubar-icon")) {
        void getCurrentWindow()
          .close()
          .catch(() => {});
        return;
      }
      void windowControl("toggle-maximize").catch(() => {});
      return;
    }
    if (IS_MAC) return;
    // No text selection, and keyboard focus stays in the terminal.
    event.preventDefault();
    event.stopPropagation();
    dragWatch.current = startDragOnMove(event.clientX, event.clientY);
  };

  return (
    <div
      className={`menubar${IS_MAC ? " is-mac" : ""}${IS_MAC && !macFullscreen ? " has-traffic-lights" : ""}`}
      ref={barRef}
      data-tauri-drag-region
      onMouseDown={onDragRegionMouseDown}
    >
      <div
        className="menubar-left"
        role="menubar"
        aria-label={t("menu.menubar")}
        data-tauri-drag-region
      >
        {!IS_MAC && (
          <img
            className="menubar-icon"
            src={appIcon}
            alt=""
            draggable={false}
            data-tauri-drag-region
          />
        )}
        {menus.map((menu, index) => {
          const isOpen = open === menu.title;
          return (
            // The panel cannot live inside the title button (a button holds
            // no interactive content), so the wrapper is the positioning box
            // and the title is a real button of its own.
            <div
              className="menu-item-slot"
              key={menu.title}
              role="none"
              onBlur={(event) => {
                // Focus moving inside the bar is the title-stepping path,
                // which opens the next menu itself; only a move out of the
                // bar dismisses.
                const next = event.relatedTarget;
                if (next instanceof Node && barRef.current?.contains(next)) return;
                setOpen(null);
              }}
            >
              <button
                ref={(element) => {
                  if (element) titleRefs.current.set(menu.title, element);
                  else titleRefs.current.delete(menu.title);
                }}
                id={`menu-title-${index}`}
                type="button"
                className={`menu-item${isOpen ? " is-open" : ""}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                // Roving tabindex: the open menu's title (or the first title
                // when none is open) is the bar's one Tab stop.
                tabIndex={isOpen || (!open && index === 0) ? 0 : -1}
                onMouseDown={() => {
                  if (isOpen) {
                    setOpen(null);
                    return;
                  }
                  openMenu(menu.title, null);
                }}
                onMouseEnter={() => {
                  if (!open || open === menu.title) return;
                  // A hover switch is a pointer gesture: do not pull focus
                  // into the new panel.
                  initialFocus.current = null;
                  setOpen(menu.title);
                }}
                onKeyDown={(event) => onTitleKeyDown(index, event)}
              >
                {menu.title}
              </button>
              {isOpen && (
                <MenuDropdown
                  label={menu.title}
                  entries={menu.entries}
                  initialFocus={initialFocus.current}
                  onClose={closeMenu}
                />
              )}
            </div>
          );
        })}
      </div>
      {!IS_MAC && (
        <div className="menubar-center" data-tauri-drag-region>
          <span className="menubar-title" data-tauri-drag-region title={windowTitle}>
            {windowTitle}
          </span>
        </div>
      )}
      {/* Layout buttons at the right end of the bar, where VS Code keeps
          its own; on Windows / Linux the window controls follow them. */}
      <div className="menubar-right" data-tauri-drag-region>
        <div className="layout-actions">
          <button
            className="panel-action"
            disabled={!activeId}
            onClick={withActive((id) => void splitSession(id, "right"))}
            title={`${t("menu.splitRight")}${accel("splitRight") ? ` (${accel("splitRight")})` : ""}`}
            aria-label={t("menu.splitRight")}
          >
            <Icon name="split-horizontal" />
          </button>
          <button
            className="panel-action"
            disabled={!activeId}
            onClick={withActive((id) => void splitSession(id, "down"))}
            title={`${t("menu.splitDown")}${accel("splitDown") ? ` (${accel("splitDown")})` : ""}`}
            aria-label={t("menu.splitDown")}
          >
            <Icon name="split-vertical" />
          </button>
        </div>
        {!IS_MAC && <WindowControls maximized={maximized} />}
      </div>
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onDisplaySettings={props.onFontSettings}
        />
      )}
    </div>
  );
}

/**
 * The panel under an open menu title. Submenus open on hover and are kept
 * open while the pointer travels over to them (see submenuHover.ts); that
 * state lives here so it is dropped with the panel. Keyboard-opened
 * submenus add a local open key on top, so the same panel serves both.
 */
function MenuDropdown({
  label,
  entries,
  initialFocus,
  onClose,
}: {
  label: string;
  entries: Menu["entries"];
  initialFocus: "first" | "last" | null;
  onClose: (mode: MenuClose) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const submenu = useSubmenuHover();
  // Which submenu the keyboard owns: a key, null after the keyboard closed
  // one, or undefined while the pointer model (submenuHover.ts) decides.
  const [keyboardOpen, setKeyboardOpen] = useState<string | null | undefined>(undefined);
  // When a dropdown has checkable entries, every entry in it (submenu
  // parents included) renders the check column so labels share one left
  // edge. Dropdowns without any stay compact.
  const showLeading = hasLeading(entries);

  const shown = (key: string) =>
    keyboardOpen === undefined ? submenu.isOpen(key) : keyboardOpen === key;

  /** The submenu panel under the entry with this key. */
  const submenuOf = (key: string) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-submenu-key="${key}"] > .menu-submenu`) ??
    null;

  /** Open a submenu from the keyboard and put focus at its first / last item. */
  const focusInto = (key: string, edge: "first" | "last") => {
    setKeyboardOpen(key);
    // The panel renders hidden until this state lands; focus after it shows.
    requestAnimationFrame(() => {
      const items = levelItems(submenuOf(key));
      (edge === "first" ? items[0] : items[items.length - 1])?.focus();
    });
  };

  // A keyboard open asks for the first / last item of this level.
  useEffect(() => {
    if (!initialFocus) return;
    const items = levelItems(rootRef.current);
    (initialFocus === "first" ? items[0] : items[items.length - 1])?.focus();
  }, [initialFocus]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>(MENU_ITEM_SELECTOR);
    if (!item) return;
    const level = item.closest<HTMLElement>(".menu-dropdown");
    const items = levelItems(level);
    const index = items.indexOf(item);
    if (index === -1) return;
    const focusAt = (next: HTMLElement | undefined) => {
      event.preventDefault();
      next?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return focusAt(items[(index + 1) % items.length]);
      case "ArrowUp":
        return focusAt(items[(index - 1 + items.length) % items.length]);
      case "Home":
        return focusAt(items[0]);
      case "End":
        return focusAt(items[items.length - 1]);
      case "ArrowRight": {
        // Only a submenu parent has somewhere to go right to.
        if (item.getAttribute("aria-haspopup") !== "menu") return;
        event.preventDefault();
        const key = item.parentElement?.dataset.submenuKey;
        if (key !== undefined) focusInto(key, "first");
        return;
      }
      case "ArrowLeft": {
        // Inside a submenu: close it and hand focus back to its parent row.
        const parent = level?.closest<HTMLElement>(".menu-submenu-entry");
        if (!parent) return;
        event.preventDefault();
        setKeyboardOpen(null);
        parent.querySelector<HTMLElement>(":scope > .menu-entry")?.focus();
        return;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose("title");
        return;
      case "Tab":
        // Close without pulling focus back: Tab continues out of the bar.
        onClose("tab");
        return;
      case "Enter":
      case " ":
        // The entry's own click runs the command (or opens a submenu) and
        // closes the menu; the keyboard must not also fire a native click.
        event.preventDefault();
        item.click();
        return;
    }
  };

  return (
    <div
      ref={rootRef}
      className="menu-dropdown"
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      {...submenu.rootProps}
    >
      {entries.map((entry, index) => {
        if (entry === "separator") {
          return <div key={index} className="menu-separator" />;
        }
        if (entry.children) {
          const children = entry.children;
          const showChildLeading = hasLeading(children);
          const key = submenuKey(undefined, index);
          const hover = submenu.entryProps(key);
          const isOpen = shown(key);
          return (
            <div
              key={entry.label}
              className={`menu-submenu-entry${isOpen ? " is-open" : ""}`}
              role="none"
              data-submenu-key={key}
              onMouseDown={(event) => event.stopPropagation()}
              {...hover}
              onMouseEnter={() => {
                // The pointer takes the submenus back from the keyboard.
                setKeyboardOpen(undefined);
                hover.onMouseEnter();
              }}
            >
              <button
                type="button"
                className="menu-entry"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                tabIndex={-1}
                title={entry.label}
                onClick={(event) => {
                  if (isOpen) return;
                  setKeyboardOpen(key);
                  // A click synthesised from the keyboard (`detail` 0) lands
                  // in the submenu; a mouse click only opens it under the
                  // pointer.
                  if (event.detail === 0) focusInto(key, "first");
                }}
              >
                {showLeading && <MenuLeading entry={entry} />}
                <span className="menu-entry-label">{entry.label}</span>
                <span className="menu-submenu-arrow" aria-hidden="true">
                  <Icon name="chevron-right" />
                </span>
              </button>
              <div className="menu-dropdown menu-submenu" role="menu" aria-label={entry.label}>
                {children.map((child, childIndex) =>
                  child === "separator" ? (
                    <div key={childIndex} className="menu-separator" />
                  ) : (
                    <button
                      key={child.label}
                      type="button"
                      className={`menu-entry${child.checked ? " is-checked" : ""}`}
                      role={menuRole(child)}
                      aria-checked={child.checked !== undefined ? child.checked : undefined}
                      tabIndex={-1}
                      title={child.label}
                      onClick={() => {
                        onClose("previous");
                        child.action?.();
                      }}
                    >
                      {showChildLeading && <MenuLeading entry={child} />}
                      <span className="menu-entry-label">{child.label}</span>
                    </button>
                  ),
                )}
              </div>
            </div>
          );
        }
        return (
          <button
            key={entry.label}
            type="button"
            className={`menu-entry${entry.checked ? " is-checked" : ""}`}
            role={menuRole(entry)}
            aria-checked={entry.checked !== undefined ? entry.checked : undefined}
            tabIndex={-1}
            title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
            onClick={() => {
              onClose("previous");
              entry.action?.();
            }}
          >
            {showLeading && <MenuLeading entry={entry} />}
            <span className="menu-entry-label">{entry.label}</span>
            {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
