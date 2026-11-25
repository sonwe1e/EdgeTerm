import { ModalDialog } from "./components/ModalDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openExternalLink } from "./openExternal";
import { exit } from "@tauri-apps/plugin-process";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useShallow } from "zustand/react/shallow";

import {
  acceptHostKey,
  declineHostKey,
  openSession,
  reopenClosedTab,
  revealCwdInFiler,
  sessionClosedNotice,
  shouldApplySessionState,
  splitSession,
} from "./actions";
import * as api from "./api";
import { useSnippetRunner } from "./components/useSnippetRunner";
import { jumpInActiveTab } from "./terminalJump";
import { useAgents } from "./agents/model";
import { AuthPromptDialog } from "./components/AuthPromptDialog";
import { ClipboardWriteDialog } from "./components/ClipboardWriteDialog";
import { CloseChoiceDialog } from "./components/CloseChoiceDialog";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { CommandPalette } from "./components/CommandPalette";
import { newSessionProfile } from "./components/SessionDialog";
import { quickConnectProfile } from "./quickConnect";
import { QuitConfirmDialog } from "./components/QuitConfirmDialog";
import { FontSizeDialog } from "./components/FontSizeDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { Icon } from "./components/icons";
import { MenuBar } from "./components/MenuBar";
import { DockArea, PanelDropOverlay } from "./components/PanelDocks";
import { PasteWarningDialog } from "./components/PasteWarningDialog";
import { SearchOverlay, type SearchOverlayHandle } from "./components/SearchOverlay";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SshConfigImportDialog } from "./components/SshConfigImportDialog";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { UpdateDialog } from "./components/UpdateDialog";
import { Workspace } from "./components/Workspace";
import { FileEditorDialog } from "./components/FileEditorDialog";
import { AgentDialog } from "./components/AgentDialog";
import { closeFileEditor } from "./fileEditor";
import { closeGitWorkspace, useGitSource } from "./gitWorkspace";
import { transferActive, useFileTransfers } from "./fileTransfers";
import { FilerPanel } from "./components/panels/FilerPanel";
import { SenderPanel } from "./components/panels/SenderPanel";
import { SessionPanel } from "./components/panels/SessionPanel";
import { applyFonts, symbolFallbacks } from "./fonts";
import { focusNextRegion } from "./focusRegions";
import { commandHistory } from "./history";
import { requestSnippetsOpen, sendSnippet } from "./snippetActions";
import type { PanelDock } from "./panelDock";
import { HAS_TRAY, IS_WINDOWS } from "./platform";
import { broadcastTargets } from "./broadcast";
import { buildPaletteCommands } from "./commandPalette";
import { surfaceOwnsKeyboard } from "./menuKeyboard";
import { importSshConfig } from "./dataTransfer";
import { matchAppShortcut, type AppShortcut } from "./shortcuts";
import {
  clampBottom,
  clampSide,
  DEFAULT_PANEL_SIZING,
  fitSides,
  loadPanelSizing,
  loadPanelSizingPreference,
  savePanelSizing,
} from "./panelSizing";
import { type PanelName, tabTitle, useStore, type Tab } from "./store";
import { zoomFontSize } from "./fontZoom";
import { BUFFER_FONT_SIZE, loadCloseActionBeforeTray } from "./storePreferences";
import { allControllers, getController, setWebglEnabled } from "./terminalRegistry";
import { isFileSession, type SessionGroup, type SessionProfile, type SessionState } from "./types";
import { useT } from "./useT";
import { useUpdater } from "./updater";
import { REPOSITORY_URL, UPSTREAM_REPOSITORY_URL } from "./distribution";
import { flushWorkspace, startWorkspace } from "./workspace";

// The largest dialog in the application, and one nothing shows until the user
// asks for a session, so it is not part of what the window opens with.
const SessionDialog = lazy(() =>
  import("./components/SessionDialog").then((module) => ({
    default: module.SessionDialog,
  })),
);

const GitWorkspaceDialog = lazy(() => import("./components/git/GitWorkspaceDialog"));

function GitWorkspaceOverlay() {
  const source = useGitSource((state) => state.source);
  if (!source) return null;
  return (
    <Suspense fallback={null}>
      <GitWorkspaceDialog
        key={JSON.stringify([source.sessionId, source.directory])}
        source={source}
        onClose={closeGitWorkspace}
      />
    </Suspense>
  );
}

/** Stable empty result for the closing-tabs selector (see `useShallow`). */
const EMPTY_CLOSING_TABS: Tab[] = [];

const exitSafely = async () => {
  if (await closeFileEditor()) {
    await flushWorkspace();
    await exit(0);
  }
};

const hasQuitWork = () =>
  useStore.getState().tabs.some((tab) => tab.state === "connecting" || tab.state === "connected") ||
  Object.values(useFileTransfers.getState().jobs).some((job) => transferActive(job.status));

/**
 * PD-01: an FTP or SFTP tab carries its own dual-pane file manager in the
 * terminal area, so the docked Filer has nothing to list for that session.
 * The panel used to be taken out of its dock entirely, which moved the
 * terminal area's edge by the dock's width the moment the user switched
 * protocols and moved it back on the return. The dock now keeps its place
 * and this notice holds the panel's, reusing the panel chrome so the
 * surface reads as the Filer itself. The Filer is deliberately not mounted
 * underneath: it would start browsing the local side the dual pane already
 * shows, and a transfer started here could not be seen behind the notice.
 */
function FilerFileSessionNotice() {
  const t = useT();
  return (
    <div className="panel filer-panel">
      <div className="panel-header">
        <div className="panel-title is-filer">
          <Icon name="folder" />
          {t("panel.filer")}
        </div>
      </div>
      {/* The same body scroller the other panels use, so the notice fills
          the panel under its header and scrolls if it cannot fit. */}
      <div className="panel-body">
        <div className="panel-empty" role="status">
          <Icon name="multiple-windows" className="panel-empty-icon" />
          <span className="panel-empty-title">{t("filer.dualPaneNotice")}</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const updater = useUpdater();
  const t = useT();
  const activeId = useStore((s) => s.activeId);
  const panels = useStore((s) => s.panels);
  const panelDocks = useStore((s) => s.panelDocks);
  const togglePanel = useStore((s) => s.togglePanel);
  const sshConfigImport = useStore((s) => s.sshConfigImport);
  const setSshConfigImport = useStore((s) => s.setSshConfigImport);
  const panelFontSize = useStore((s) => s.panelFontSize);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const lineHeight = useStore((s) => s.lineHeight);
  const setLineHeight = useStore((s) => s.setLineHeight);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const panelFontFamily = useStore((s) => s.panelFontFamily);
  const bufferFontFamily = useStore((s) => s.bufferFontFamily);
  const symbolFontFamilies = useStore((s) => s.symbolFontFamilies);
  const systemMonoFamily = useStore((s) => s.systemMonoFamily);
  const setPanelFontSize = useStore((s) => s.setPanelFontSize);
  const setBufferFontSize = useStore((s) => s.setBufferFontSize);
  const setPanelFontFamily = useStore((s) => s.setPanelFontFamily);
  const setBufferFontFamily = useStore((s) => s.setBufferFontFamily);
  const setTerminalScrollback = useStore((s) => s.setTerminalScrollback);
  const cursorStyle = useStore((s) => s.cursorStyle);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const setCursorStyle = useStore((s) => s.setCursorStyle);
  const setCursorBlink = useStore((s) => s.setCursorBlink);
  const gpuRenderer = useStore((s) => s.gpuRenderer);
  const setGpuRenderer = useStore((s) => s.setGpuRenderer);
  const shortcuts = useStore((s) => s.shortcuts);
  const snippets = useStore((s) => s.snippets);
  const setShortcuts = useStore((s) => s.setShortcuts);
  const setActive = useStore((s) => s.setActive);
  const setTheme = useStore((s) => s.setTheme);
  const broadcastInput = useStore((s) => s.broadcastInput);
  const broadcastCount = useStore(
    (s) =>
      broadcastTargets(s.tabs, s.activeId, s.broadcastExcluded, s.broadcastExcludedGroups).length,
  );
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);
  const activateAdjacentPane = useStore((s) => s.activateAdjacentPane);
  const closeTab = useStore((s) => s.closeTab);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const setClosePrompt = useStore((s) => s.setClosePrompt);
  /**
   * Live terminal zoom: one pixel per press, and 0 means "back to default".
   * The store clamps and persists, so a rebound key and the display dialog end
   * up at the same value.
   */
  const bumpFontSize = useCallback(
    (delta: number) => {
      const store = useStore.getState();
      const next =
        delta === 0 ? BUFFER_FONT_SIZE.default : zoomFontSize(store.bufferFontSize, delta);
      if (next !== store.bufferFontSize) store.setBufferFontSize(next);
      store.setStatus(t("status.fontSize", { size: next }));
    },
    [t],
  );
  const toggleZoomedPane = useStore((s) => s.toggleZoomedPane);
  const applyState = useStore((s) => s.applyState);
  const hostKeyPrompt = useStore((s) => s.hostKeyPrompt);
  // A connection stops mid-handshake for each round; answer the oldest first.
  const authPrompt = useStore((s) => s.authPrompts[0] ?? null);
  const addAuthPrompt = useStore((s) => s.addAuthPrompt);
  const clearAuthPrompt = useStore((s) => s.clearAuthPrompt);
  const theme = useStore((s) => s.theme);
  // The palette needs the open tabs and saved sessions, but App must not
  // re-render on every background activity tick: these project just the fields
  // a palette label reads, as JSON strings, so useShallow keeps the reference
  // until one of those fields actually changes.
  const paletteTabKeys = useStore(
    useShallow((s) =>
      s.tabs.map((tab) =>
        JSON.stringify([tab.info.id, tabTitle(tab), tab.info.address ?? "", tab.number]),
      ),
    ),
  );
  const paletteProfileKeys = useStore(
    useShallow((s) =>
      s.profiles.map((profile) =>
        JSON.stringify([
          profile.id,
          profile.name,
          profile.kind,
          profile.host ?? "",
          profile.username ?? "",
          profile.shell ?? "",
          profile.port ?? 0,
        ]),
      ),
    ),
  );
  // A boolean, not the tab: the tab object changes with every resize and
  // every command state, and none of that is the App's business.
  const fileMode = useStore((s) => {
    const tab = s.tabs.find((item) => item.info.id === s.activeId);
    return tab ? isFileSession(tab.info.kind) : false;
  });
  const pastePrompt = useStore((s) => s.pastePrompt);
  const setPastePrompt = useStore((s) => s.setPastePrompt);
  const setPasteWarning = useStore((s) => s.setPasteWarning);
  const clipboardPrompt = useStore((s) => s.clipboardPrompt);
  const setClipboardPrompt = useStore((s) => s.setClipboardPrompt);
  const setProgramClipboard = useStore((s) => s.setProgramClipboard);
  const clipboardTab = useStore((s) =>
    clipboardPrompt ? s.tabs.find((tab) => tab.info.id === clipboardPrompt.sessionId) : undefined,
  );
  // Derived with a shallow selector: the tab list changes identity on
  // every resize or another tab's command state, and none of that may
  // re-render the whole tree — only a pending close's own tabs matter.
  const closingTabs = useStore(
    useShallow((s) => {
      const prompt = s.closePrompt;
      return prompt ? s.tabs.filter((tab) => prompt.includes(tab.info.id)) : EMPTY_CLOSING_TABS;
    }),
  );

  const [dialog, setDialog] = useState<{
    profile: SessionProfile | null;
    /** The group a new session should land in, when one was chosen. */
    group?: SessionGroup;
    /** The open tab whose settings are being saved, when saving one. */
    saveSessionId?: string;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<SearchOverlayHandle>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [fontSettingsOpen, setFontSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The settings surface lives here rather than in the menu bar so the command
  // palette can open it too: its "Settings" group is the palette's own way in.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Hosts connected from the palette's field or an ssh:// link, newest first:
  // the palette offers them back so the same machine is one keystroke away.
  const recentTargets = useStore((s) => s.quickConnectRecents);
  // Bumped when the palette opens: the history list is captured in memory, so
  // the catalogue is rebuilt at that moment instead of on every recorded
  // command (which would re-render the window on each Enter).
  const [historyTag, setHistoryTag] = useState(0);
  const openPalette = useCallback(() => {
    setHistoryTag((tag) => tag + 1);
    setPaletteOpen(true);
  }, []);
  const [quitPromptOpen, setQuitPromptOpen] = useState(false);
  // The close-choice dialog ("minimize to tray, or quit?"), shown while the
  // closeAction setting is "ask".
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const closeAction = useStore((s) => s.closeAction);
  const setCloseAction = useStore((s) => s.setCloseAction);

  // The layout the user arranged last time; reloaded when settings are
  // imported or restored (the revision bump), and saved below after a drag.
  const [initialSizing] = useState(loadPanelSizing);
  const [initialPreference] = useState(loadPanelSizingPreference);
  const [leftWidth, setLeftWidth] = useState(initialSizing.left);
  const [rightWidth, setRightWidth] = useState(initialSizing.right);
  const [bottomHeight, setBottomHeight] = useState(initialSizing.bottom);
  const [senderExpanded, setSenderExpanded] = useState(initialSizing.senderExpanded);
  const agentComposeRequest = useAgents((s) => s.composeRequest);
  useEffect(() => {
    if (!agentComposeRequest) return;
    if (!useStore.getState().panels.sender) useStore.getState().togglePanel("sender");
    setSenderExpanded(true);
    setBottomHeight((height) => Math.max(height, 250));
  }, [agentComposeRequest]);
  const panelPreferencesRevision = useStore((s) => s.panelPreferencesRevision);
  const widthRefs = useRef({ left: leftWidth, right: rightWidth });
  widthRefs.current = { left: leftWidth, right: rightWidth };
  // What the user asked each dock to be — the persisted preference — as
  // distinct from the size currently shown. A window too small for the docks
  // shrinks what is shown (the resize handler below re-fits from these values)
  // without overwriting the preference, so widening the window again gives the
  // arrangement back instead of cementing the temporary squeeze.
  const preferredSides = useRef({
    left: initialPreference.left,
    right: initialPreference.right,
  });
  const preferredBottom = useRef(initialPreference.bottom);

  useEffect(() => {
    const next = loadPanelSizing();
    const wanted = loadPanelSizingPreference();
    preferredSides.current = { left: wanted.left, right: wanted.right };
    preferredBottom.current = wanted.bottom;
    setLeftWidth(next.left);
    setRightWidth(next.right);
    setBottomHeight(next.bottom);
    setSenderExpanded(next.senderExpanded);
  }, [panelPreferencesRevision]);

  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        savePanelSizing({
          left: preferredSides.current.left,
          right: preferredSides.current.right,
          bottom: preferredBottom.current,
          senderExpanded,
        }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [leftWidth, rightWidth, bottomHeight, senderExpanded]);

  // A smaller window must not keep a dock width that no longer leaves room
  // for the terminal; fit both sides together — from the preference, never
  // from the shown widths, so the squeeze this causes is not what gets saved.
  useEffect(() => {
    const onResize = () => {
      const sides = fitSides(
        preferredSides.current.left,
        preferredSides.current.right,
        window.innerWidth,
      );
      setLeftWidth(sides.left);
      setRightWidth(sides.right);
      setBottomHeight(clampBottom(preferredBottom.current, window.innerHeight));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --- backend events -------------------------------------------------------

  useEffect(() => {
    // Opt-in feature: fetch the history only for users who enabled it.
    if (useStore.getState().suggestionsEnabled) commandHistory.load();
  }, []);

  // The window is hidden until there is an interface to show, so the
  // application opens on the UI rather than on an empty frame (issue #35).
  // A hidden window never paints, and `requestAnimationFrame` never fires
  // with it. On Windows the native window remains cloaked for two visible
  // frames, giving WebView2 time to replace its solid startup background.
  useEffect(() => {
    void api
      .showMainWindow()
      .then(() => {
        if (IS_WINDOWS) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              void api.finishMainWindow().catch(() => {});
            });
          });
        }
      })
      .catch(() => {});
  }, []);

  // The Linux terminal stack leads with the face fontconfig calls
  // `monospace` (see `fontStack`, issue #78). Asked right away rather than
  // with the font scan below, so the first session measures its cells in
  // that face; the answer is null on the other platforms.
  useEffect(() => {
    void api
      .systemMonospaceFamily()
      .then((family) => {
        if (family) useStore.getState().setSystemMonoFamily(family);
      })
      .catch(() => {});
  }, []);

  // xterm is loaded with the first session (see `ensureController`), which
  // leaves the start-up bundle small but would make that first session wait
  // for it. Fetch it in the quiet moment after the window is up instead. The
  // same moment reads the installed fonts for the terminal stack's icon
  // fallback (see `symbolFallbacks`); a terminal already open by then just
  // switches stacks when the answer comes.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("./terminal");
      api
        .listSystemFonts()
        .then((fonts) => useStore.getState().setSymbolFontFamilies(symbolFallbacks(fonts)))
        .catch(() => undefined);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, []);

  // Theme is applied in three places: the CSS variable palette keys off the
  // root data-theme attribute, each live terminal owns its own xterm theme
  // object, and the controller passes the theme on to the semantic layer —
  // which lives in the terminal bundle, so the shell never loads it. The
  // backend is told as well, so the next launch opens its window in this
  // theme's background colour; a failed write only costs that.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    for (const controller of allControllers()) controller.setTheme(theme);
    void api.setStartupTheme(theme).catch(() => {});
  }, [theme]);

  // main.tsx published the stored families before the first paint; keep the
  // two CSS variables in step with later changes. Live terminals get theirs
  // from TerminalPane, which owns the xterm instance.
  useEffect(() => {
    applyFonts(bufferFontFamily, panelFontFamily, symbolFontFamilies, systemMonoFamily);
  }, [bufferFontFamily, panelFontFamily, symbolFontFamilies, systemMonoFamily]);

  // Terminal output no longer passes through here: each session streams its
  // bytes on the raw channel `connectSession` hands the backend, straight
  // into its controller (see actions.ts and OutputPump in session/mod.rs).

  useEffect(() => {
    const unlisten = api.onSessionState(({ id, state, message }) => {
      if (!shouldApplySessionState(id)) return;
      applyState(id, state as SessionState, message ?? undefined);
      if (state === "closed") {
        getController(id)?.writeText(sessionClosedNotice());
      }
    });
    const authUnlisten = api.onAuthPrompt((prompt) => {
      if (!shouldApplySessionState(prompt.sessionId)) {
        // The native handshake can still be waiting after its tab/attempt
        // was cancelled. Release that round without reopening a stale dialog.
        void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
        return;
      }
      addAuthPrompt(prompt);
    });
    const stopWorkspace = startWorkspace(Promise.all([unlisten, authUnlisten]));
    return () => {
      stopWorkspace();
      void unlisten.then((off) => off());
      void authUnlisten.then((off) => off());
    };
  }, [applyState, addAuthPrompt]);

  // A recording the backend had to give up on (disk full, folder gone) is
  // reported against its session; the session itself carries on.
  useEffect(() => {
    const unlisten = api.onRecordingError(({ id, path, message }) => {
      const store = useStore.getState();
      store.setError(t("status.recordingStopped", { error: message, path }), id);
      const tab = store.tabs.find((item) => item.info.id === id);
      // The REC chip is a button and can hold focus; clearing it unmounts the
      // control, which would otherwise drop focus onto the document.
      const chipHadFocus = document.activeElement?.closest("[data-recording-chip]") != null;
      if (tab) store.updateTabInfo(id, { ...tab.info, recording: null });
      if (chipHadFocus) {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>("[data-focus-region='status']")?.focus();
        });
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [t]);

  // A tab-close prompt open underneath would race this dialog for
  // Enter/Esc (both listen on window in the capture phase), so drop it.
  const openQuitPrompt = useCallback(() => {
    setClosePrompt(null);
    setQuitPromptOpen(true);
  }, [setClosePrompt]);

  // The renderer preference is module state in terminalRegistry.ts (the WebGL
  // renderers live outside React); applying it here covers both start-up and
  // Display Settings → Apply. A terminal may have loaded WebGL a frame before
  // the start-up pass runs; refreshWebgl brings every controller onto the
  // preference regardless.
  useEffect(() => {
    setWebglEnabled(gpuRenderer);
  }, [gpuRenderer]);

  // Closing the window (macOS ✕, the menubar Close button on Windows,
  // Alt+F4) must not silently drop live connections: hold the close and
  // confirm while any tab is live or a background transfer is unfinished. Without the
  // preventDefault the listener itself destroys the window.
  //
  // The closeAction setting routes first: "tray" hides the window with every
  // session running, "ask" opens the choice dialog, and "exit" skips the
  // choice (but never the unfinished-work confirm — one gesture still cannot
  // drop every connection or transfer). Reading through getState keeps the
  // listener from re-arming on every preference change.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      const action = HAS_TRAY ? useStore.getState().closeAction : "exit";
      if (action === "tray") {
        event.preventDefault();
        void api.hideMainWindow();
        return;
      }
      if (action === "ask") {
        event.preventDefault();
        setCloseChoiceOpen(true);
        return;
      }
      if (!hasQuitWork()) {
        event.preventDefault();
        void exitSafely();
        return;
      }
      event.preventDefault();
      openQuitPrompt();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [openQuitPrompt]);

  // The tray's check item mirrors the setting; the flip from the tray's own
  // side arrives below and lands in the same setter, whose write back is
  // idempotent, so the two cannot chase each other.
  useEffect(() => {
    api.setCloseToTray(closeAction === "tray").catch(() => {
      // No tray (Linux) or a headless test: the setting still holds locally.
    });
  }, [closeAction]);

  // The tray is the only surface left once the window is parked there, and it
  // carries the app's only Quit entry, so it speaks the interface's language.
  useEffect(() => {
    api
      .setTrayLabels({
        open: t("tray.open"),
        toggle: t("tray.toggle"),
        quit: t("tray.quit"),
      })
      .catch(() => {
        // No tray (Linux) or a headless test: nothing to relabel.
      });
  }, [t]);

  useEffect(() => {
    const unlisten = api.onCloseToTrayChanged((enabled) => {
      // Un-ticking restores what the reader had chosen; writing "ask" here
      // would bring back a prompt they had deliberately turned off.
      useStore.getState().setCloseAction(enabled ? "tray" : loadCloseActionBeforeTray());
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // ⌘Q on macOS bypasses the window close path, so the Rust menu handler
  // forwards it here; background transfers outlive their tabs and also need a guard.
  useEffect(() => {
    const unlisten = api.onQuitRequested(() => {
      if (hasQuitWork()) openQuitPrompt();
      else void exitSafely();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [openQuitPrompt]);

  // --- actions --------------------------------------------------------------

  const newSession = useCallback(() => setDialog({ profile: null }), []);
  const newSessionInGroup = useCallback(
    (group?: SessionGroup) => setDialog({ profile: null, group }),
    [],
  );
  // Saves an open tab's own settings, which may have been changed after it was
  // opened, as a profile without dialling another connection.
  const saveSession = useCallback((id: string) => {
    const tab = useStore.getState().tabs.find((item) => item.info.id === id);
    if (!tab) return;
    setDialog({ profile: tab.profile, saveSessionId: id });
  }, []);

  // Opening the box focuses it via its mount effect; when it is already
  // open that effect does not re-run, so refocus it explicitly.
  const openSearch = useCallback(() => {
    if (fileMode) return;
    if (searchOpen) searchRef.current?.focus();
    else setSearchOpen(true);
  }, [fileMode, searchOpen]);

  // Jump to the next match; with the search box closed this just opens it
  // so the user can type a query.
  const findNext = useCallback(() => {
    if (fileMode) return;
    if (!searchOpen) setSearchOpen(true);
    else searchRef.current?.findNext();
  }, [fileMode, searchOpen]);

  // --- keyboard -------------------------------------------------------------

  // Both copy commands report through the status bar: the palette closes on
  // run, so without a message a refused copy would look like a successful one.
  const copyFromTerminal = useCallback(
    (copy: (controller: NonNullable<ReturnType<typeof getController>>) => boolean) => {
      const state = useStore.getState();
      const controller = state.activeId ? getController(state.activeId) : null;
      const copied = controller ? copy(controller) : false;
      state.setStatus(copied ? t("status.copiedFromTerminal") : t("status.nothingToCopy"));
    },
    [t],
  );

  // Synchronized input is one toggle, shared by the keyboard, the palette and
  // the Session menu. The store owns the refusal rules.
  const toggleBroadcast = useCallback(() => {
    const state = useStore.getState();
    state.setBroadcastInput(!state.broadcastInput);
  }, []);

  // One dispatcher for the keyboard and the command palette: a command must do
  // the same thing however it was invoked, and a rebinding must never leave the
  // palette on a different code path. The return value says whether the app
  // answered at all, so the key handler only suppresses the browser default for
  // keys this app actually owns.
  const runShortcut = useCallback(
    (shortcut: AppShortcut): boolean => {
      // A command that needs a session to act on says so instead of doing
      // nothing: the palette row, the menu entry and the chord all reach this
      // one dispatcher, and a refusal that looks like success is the worst
      // outcome of the three.
      const refuseNoSession = () => {
        useStore.getState().setStatus(t("status.noActiveSession"));
        return false;
      };
      const refuseNoTerminal = () => {
        useStore.getState().setStatus(t("status.noTerminal"));
        return false;
      };
      switch (shortcut.kind) {
        case "commandPalette":
          openPalette();
          return true;
        case "snippets":
          requestSnippetsOpen();
          return true;
        case "broadcast":
          toggleBroadcast();
          return true;
        // The three buffer walks share one implementation (terminalJump), so
        // the keyboard, the palette and the menu cannot drift apart.
        case "prevCommand":
          jumpInActiveTab("command", -1);
          return true;
        case "nextCommand":
          jumpInActiveTab("command", 1);
          return true;
        case "prevFailed":
          jumpInActiveTab("failed", -1);
          return true;
        case "nextFailed":
          jumpInActiveTab("failed", 1);
          return true;
        case "prevWatch":
          jumpInActiveTab("watch", -1);
          return true;
        case "nextWatch":
          jumpInActiveTab("watch", 1);
          return true;
        case "copyCommandOutput":
          copyFromTerminal((controller) => controller.copyLastCommandOutput());
          return true;
        case "copyCommand":
          copyFromTerminal((controller) => controller.copyLastCommand());
          return true;
        case "focusRegion":
          return focusNextRegion(1);
        case "tabStep":
          activateAdjacentTab(shortcut.step);
          return true;
        case "togglePanel":
          togglePanel(shortcut.panel);
          return true;
        case "newSession":
          newSession();
          return true;
        case "closeSession":
          if (!activeId) return refuseNoSession();
          requestCloseTab(activeId);
          return true;
        case "reopenTab":
          void reopenClosedTab();
          return true;
        case "zoomPane":
          toggleZoomedPane();
          return true;
        case "fontSizeUp":
          bumpFontSize(1);
          return true;
        case "fontSizeDown":
          bumpFontSize(-1);
          return true;
        case "fontSizeReset":
          bumpFontSize(0);
          return true;
        case "find":
          openSearch();
          return true;
        case "findNext":
          findNext();
          return true;
        case "clear":
          if (!activeId) return refuseNoSession();
          if (fileMode) return refuseNoTerminal();
          getController(activeId)?.clear();
          return true;
        case "revealCwd":
          if (!activeId) return refuseNoSession();
          if (fileMode) return refuseNoTerminal();
          void revealCwdInFiler(activeId);
          return true;
        case "splitPane":
          if (!activeId) return refuseNoSession();
          void splitSession(activeId, shortcut.side);
          return true;
        case "paneStep":
          activateAdjacentPane(shortcut.step);
          return true;
        case "copy":
        case "paste":
        case "selectAll":
          // The terminal's own: its key filter answers them while it has
          // focus (see terminal.ts). Anywhere else the browser keeps its
          // native editing keys, so ⌘C in a text field still copies from it.
          return false;
        case "tab": {
          const tab = useStore.getState().tabs.find((item) => item.number === shortcut.number);
          if (!tab) return false;
          setActive(tab.info.id);
          return true;
        }
      }
    },
    [
      activateAdjacentPane,
      activateAdjacentTab,
      activeId,
      bumpFontSize,
      copyFromTerminal,
      findNext,
      fileMode,
      newSession,
      openPalette,
      openSearch,
      requestCloseTab,
      setActive,
      t,
      toggleBroadcast,
      togglePanel,
      toggleZoomedPane,
    ],
  );

  // Synchronized input cannot outlive its recipients: when the last other
  // connected shell goes away, the mode turns itself off rather than waiting
  // to surprise whichever session connects next.
  useEffect(() => {
    if (broadcastInput && broadcastCount === 0) {
      useStore.getState().setBroadcastInput(false);
    }
  }, [broadcastCount, broadcastInput]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // xterm keeps a hidden textarea for input, so "focus is in a text field"
      // has to exclude the terminal itself or every shortcut would be dead
      // exactly where it matters most.
      const target = event.target as HTMLElement | null;
      const inTerminal = Boolean(target?.closest(".xterm"));
      if (!inTerminal && target?.closest("input, textarea, select")) return;

      // A surface that owns the keyboard is open - a native modal, a context
      // menu, or a menu-bar dropdown. Both menu surfaces are plain divs in a
      // portal, so the dialog test above does not catch them: without this a
      // chord pressed with a menu on screen runs the command and leaves the
      // menu standing over the result, its entries still describing the state
      // it was opened with.
      if (surfaceOwnsKeyboard(target)) return;

      // The modifier scheme is platform-specific (⌘ on macOS, Alt elsewhere)
      // and lives in shortcuts.ts; only the dispatch happens here.
      const shortcut = matchAppShortcut(event);
      if (!shortcut) return;
      if (runShortcut(shortcut)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runShortcut]);

  // The saved-command surfaces own their dialogs and their entry points.
  const snippetsUi = useSnippetRunner();

  const recentProfiles = useStore((s) => s.recentProfiles);

  // The palette catalogue is rebuilt only when something it displays changes:
  // the language, a rebinding, the theme, or one of the tab/session labels.
  const paletteCommands = useMemo(
    () =>
      buildPaletteCommands({
        t,
        shortcuts,
        theme,
        tabs: paletteTabKeys.map((key) => {
          const [id, title, address] = JSON.parse(key) as [string, string, string, number];
          return { id, title, hint: address };
        }),
        recentProfiles,
        profiles: paletteProfileKeys.map((key) => {
          const [id, name, kind, host, username, shell, port] = JSON.parse(key) as [
            string,
            string,
            string,
            string,
            string,
            string,
            number,
          ];
          // The port is part of how this session is reached, so it belongs in
          // the hint the palette scores: Ctrl+P then finds it by address, the
          // way the tree's filter does (see sessionFilter.ts).
          const target = host ? (username ? username + "@" + host : host) : shell;
          const address = host && port ? target + ":" + port : target;
          return { id, name, hint: [kind, address].filter(Boolean).join(" · ") };
        }),
        snippets: snippets.map(({ id, name, command }) => ({ id, name, command })),
        history: commandHistory.recent(40).map(({ command, host }) => ({ command, host })),
        actions: {
          runShortcut: (action) => {
            runShortcut(action);
          },
          // The three the keyboard leaves to the terminal's own key filter.
          // From the palette there is no filter to answer them, so the row
          // goes to the terminal directly and reports a refusal the same way
          // the two copy chords do.
          runTerminalCommand: (command) => {
            if (command === "copy") {
              copyFromTerminal((controller) => controller.copySelection());
              return;
            }
            if (command === "paste") {
              void getController(useStore.getState().activeId ?? "")?.pasteFromClipboard();
              return;
            }
            getController(useStore.getState().activeId ?? "")?.selectAll();
          },
          sendSnippet: (id) => {
            const snippet = useStore.getState().snippets.find((item) => item.id === id);
            if (snippet) snippetsUi.runSnippet(snippet);
          },
          saveLastCommandAsSnippet: snippetsUi.saveLastCommandAsSnippet,
          sendHistory: (command) => {
            // The same funnel typed commands use: it refuses a non-shell
            // session with a reason instead of writing bytes nowhere.
            void sendSnippet({ id: "history", name: command, command });
          },
          openSnippetsDialog: snippetsUi.openSnippets,
          activateTab: (id) => setActive(id),
          connectProfile: (id) => {
            const profile = useStore.getState().profiles.find((item) => item.id === id);
            if (profile) void openSession(profile);
          },
          setTheme,
          openDisplaySettings: () => setFontSettingsOpen(true),
          openShortcutSettings: () => setShortcutsOpen(true),
          openSettings: () => setSettingsOpen(true),
          openAbout: () => setAboutOpen(true),
          checkForUpdates: () => void updater.checkForUpdates(),
          importSshConfig: () => void importSshConfig(),
        },
      }),
    [
      copyFromTerminal,
      historyTag,
      paletteProfileKeys,
      paletteTabKeys,
      recentProfiles,
      runShortcut,
      setActive,
      setTheme,
      snippetsUi,
      shortcuts,
      snippets,
      t,
      theme,
      updater,
    ],
  );

  // F6 / Shift+F6 cycle the focus regions. This runs in the capture phase
  // because xterm answers function keys itself and keeps the event from
  // reaching a bubble-phase listener: the terminal is exactly where the key
  // is needed, since Tab inside it belongs to the shell. F6 stays reserved
  // even if the rebindable focusRegion command is moved to another chord.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("dialog[open]")) return;
      const moved = event.shiftKey ? focusNextRegion(-1) : focusNextRegion(1);
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // --- layout ---------------------------------------------------------------

  // Each panel sits in the dock the user put it in (see panelDock.ts).
  // FTP and SFTP tabs bring their own dual-pane file manager in the
  // terminal area, so the Filer shows a placeholder there instead (see
  // FilerFileSessionNotice). Dropping it from this list used to unmount
  // its whole dock, which widened the terminal area by the dock's width
  // on every protocol switch and narrowed it again on the way back
  // (PD-01).
  const shown = (dock: PanelDock) => panelDocks[dock].filter((panel) => panels[panel]);
  const left = shown("left");
  const right = shown("right");
  const bottom = shown("bottom");
  const senderCanCompact = bottom.length === 1 && bottom[0] === "sender";
  const senderCompact = senderCanCompact && !senderExpanded;

  // --- side dock drags -------------------------------------------------------
  //
  // Pointer moves update a guide outside React; release applies the dock
  // width once. Keeping the terminal's container still during the gesture
  // avoids repeated xterm reflows and renderer resizes when a pointer pauses
  // longer than the terminal's fit debounce.
  const mainRef = useRef<HTMLDivElement>(null);
  const sideDrag = useRef<{
    side: "left" | "right";
    /** The dock's width when the drag began; deltas are measured against it. */
    base: number;
    /** Pointer movement since the drag began, never clamped — the clamp is
     * applied to the target each frame, so backing away from a boundary the
     * drag just hit moves the splitter again on the very next frame. */
    total: number;
    /** The last width indicated by the guide: what release or cancel commits. */
    shown: number;
    target: HTMLDivElement;
  } | null>(null);

  const otherShownSide = (side: "left" | "right") =>
    side === "left"
      ? right.length > 0
        ? widthRefs.current.right
        : 0
      : left.length > 0
        ? widthRefs.current.left
        : 0;

  const commitSide = (side: "left" | "right", width: number) => {
    preferredSides.current[side] = width;
    if (side === "left") setLeftWidth(width);
    else setRightWidth(width);
  };

  // A double-click on a side dock's splitter gives that dock its default
  // width back. The same clamp the pointer meets decides what the default is
  // on this window, so a narrow window cannot restore a width that would
  // squeeze the terminal away.
  const resetSide = (side: "left" | "right") => {
    const width = clampSide(DEFAULT_PANEL_SIZING[side], window.innerWidth, otherShownSide(side));
    mainRef.current?.style.setProperty(
      side === "left" ? "--dock-left-w" : "--dock-right-w",
      `${width}px`,
    );
    commitSide(side, width);
  };

  const beginSideDrag = (side: "left" | "right", target: HTMLDivElement) => {
    target.dataset.preview = "";
    sideDrag.current = {
      side,
      base: widthRefs.current[side],
      total: 0,
      shown: widthRefs.current[side],
      target,
    };
  };

  const applySideFrame = (side: "left" | "right", delta: number) => {
    const live = sideDrag.current;
    if (!live || live.side !== side || !live.target.isConnected) {
      if (live && !live.target.isConnected) sideDrag.current = null;
      // A keypress arrives with no drag behind it: apply it immediately,
      // through the same clamp the pointer meets, and commit like a release.
      commitSide(
        side,
        clampSide(widthRefs.current[side] + delta, window.innerWidth, otherShownSide(side)),
      );
      return;
    }
    live.total += delta;
    const target = clampSide(
      live.base + (side === "left" ? live.total : -live.total),
      window.innerWidth,
      otherShownSide(side),
    );
    live.shown = target;
    const offset = (target - live.base) * (side === "left" ? 1 : -1);
    live.target.style.setProperty("--splitter-preview-x", `${offset}px`);
  };

  const endSideDrag = () => {
    const live = sideDrag.current;
    sideDrag.current = null;
    // A release and an interruption alike keep the last guide position,
    // matching the previous splitter contract for already-applied movement.
    if (live) {
      live.target.removeAttribute("data-preview");
      live.target.style.removeProperty("--splitter-preview-x");
      mainRef.current?.style.setProperty(
        live.side === "left" ? "--dock-left-w" : "--dock-right-w",
        `${live.shown}px`,
      );
      commitSide(live.side, live.shown);
    }
  };

  const renderPanel = (panel: PanelName) =>
    panel === "sessions" ? (
      <SessionPanel
        onNewSession={newSessionInGroup}
        onEditProfile={(profile) => setDialog({ profile })}
      />
    ) : panel === "filer" ? (
      fileMode ? (
        <FilerFileSessionNotice />
      ) : (
        <FilerPanel />
      )
    ) : (
      <SenderPanel
        compact={senderCompact}
        canCompact={senderCanCompact}
        onExpandedChange={setSenderExpanded}
      />
    );

  return (
    <div
      className="app"
      style={
        {
          "--panel-font-size": `${panelFontSize}px`,
          "--buffer-font-size": `${bufferFontSize}px`,
        } as CSSProperties
      }
    >
      <MenuBar
        onNewSession={newSession}
        onSnippets={snippetsUi.openSnippets}
        onFind={openSearch}
        onFindNext={findNext}
        onCommandPalette={openPalette}
        broadcast={broadcastInput}
        onBroadcast={toggleBroadcast}
        onFontSettings={() => setFontSettingsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onKeyboardShortcuts={() => setShortcutsOpen(true)}
        onCheckForUpdates={() => void updater.checkForUpdates()}
        onAbout={() => setAboutOpen(true)}
      />

      <div className="app-body">
        <div
          className="main"
          ref={mainRef}
          style={
            {
              "--dock-left-w": `${leftWidth}px`,
              "--dock-right-w": `${rightWidth}px`,
            } as CSSProperties
          }
        >
          {left.length > 0 && (
            <>
              <DockArea dock="left" panels={left} size={leftWidth} render={renderPanel} />
              <Splitter
                orientation="vertical"
                onDragStart={(target) => beginSideDrag("left", target)}
                onResize={(delta) => applySideFrame("left", delta)}
                onEnd={() => endSideDrag()}
                readout={() => sideDrag.current?.shown ?? null}
                onReset={() => resetSide("left")}
              />
            </>
          )}

          <div className="center">
            <Workspace
              onNewSession={newSession}
              onSaveSession={saveSession}
              onOpenProfile={(profile) => void openSession(profile)}
            >
              {searchOpen && <SearchOverlay ref={searchRef} onClose={() => setSearchOpen(false)} />}
            </Workspace>
          </div>

          {right.length > 0 && (
            <>
              <Splitter
                orientation="vertical"
                onDragStart={(target) => beginSideDrag("right", target)}
                onResize={(delta) => applySideFrame("right", delta)}
                onEnd={() => endSideDrag()}
                readout={() => sideDrag.current?.shown ?? null}
                onReset={() => resetSide("right")}
              />
              <DockArea dock="right" panels={right} size={rightWidth} render={renderPanel} />
            </>
          )}
        </div>

        {bottom.length > 0 && (
          <>
            <Splitter
              orientation="horizontal"
              onResize={(delta) => {
                const dragBottom = (height: number) => {
                  const next = clampBottom(height - delta, window.innerHeight);
                  preferredBottom.current = next;
                  return next;
                };
                if (senderCompact) {
                  if (delta < 0) {
                    setSenderExpanded(true);
                    setBottomHeight(dragBottom);
                  }
                } else {
                  setBottomHeight(dragBottom);
                }
              }}
            />
            <DockArea
              dock="bottom"
              panels={bottom}
              size={senderCompact ? 42 : bottomHeight}
              render={renderPanel}
            />
          </>
        )}
        <div id="transfer-dock" className="transfer-dock" />
        <PanelDropOverlay />
      </div>

      <StatusBar />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        onQuickConnect={(target) => {
          // Nothing is saved: the tab carries the target the reader typed, and
          // the editor is only reached when they decide to keep the session.
          setPaletteOpen(false);
          // Remembered after it connects (see actions), not before the attempt.
          void openSession(quickConnectProfile(target, newSessionProfile()));
        }}
        describeQuickConnect={(target) => {
          // The same defaults the session itself starts from, so the row says
          // which user and port an omitted part will fall back to.
          const profile = quickConnectProfile(target, newSessionProfile());
          // A host typed without an account has none to name: the "SSH as …"
          // sentence would read as a gap, so say what the row does instead.
          if (!profile.username) return t("palette.quickConnectHint");
          return t("palette.quickConnectAs", {
            user: profile.username,
            port: String(profile.port ?? 22),
          });
        }}
        recentTargets={recentTargets}
      />

      <UpdateDialog
        appVersion={updater.appVersion}
        state={updater.state}
        onDismiss={updater.dismiss}
        onOpenDownloads={() => void updater.openDownloads()}
      />

      {dialog && (
        <Suspense fallback={null}>
          <SessionDialog
            initial={dialog.profile}
            initialGroup={dialog.group}
            saveSessionId={dialog.saveSessionId}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}

      {closingTabs.length > 0 && (
        <CloseSessionDialog
          tabs={closingTabs}
          onConfirm={() => {
            // Dismiss first so a second Enter cannot re-enter closeTab while
            // the backend close is still in flight.
            setClosePrompt(null);
            for (const tab of closingTabs) void closeTab(tab.info.id);
          }}
          onCancel={() => setClosePrompt(null)}
        />
      )}

      <GitWorkspaceOverlay />
      <FileEditorDialog />
      <AgentDialog />
      {quitPromptOpen && (
        <QuitConfirmDialog
          onConfirm={() => {
            setQuitPromptOpen(false);
            void exitSafely();
          }}
          onCancel={() => setQuitPromptOpen(false)}
        />
      )}

      {closeChoiceOpen && (
        <CloseChoiceDialog
          onChoice={(choice, remember) => {
            setCloseChoiceOpen(false);
            // "Remember" promotes the picked action to the setting, so the
            // dialog stops appearing; the settings menu can put it back on
            // "ask". Hiding needs no confirm (sessions keep running), while
            // "Exit" walks the same guard as a plain close.
            if (remember) setCloseAction(choice === "tray" ? "tray" : "exit");
            if (choice === "tray") {
              void api.hideMainWindow();
              return;
            }
            if (hasQuitWork()) openQuitPrompt();
            else void exitSafely();
          }}
          onCancel={() => setCloseChoiceOpen(false)}
        />
      )}

      {pastePrompt && (
        <PasteWarningDialog
          key={pastePrompt.sessionId}
          text={pastePrompt.text}
          onConfirm={(remember) => {
            // Dismiss first: the dialog's own Enter must not reach the
            // terminal that is about to receive the paste.
            setPastePrompt(null);
            if (remember) setPasteWarning(false);
            // The dialog took focus from the terminal; hand it back so typing
            // continues after the pasted lines (issue #73).
            const controller = getController(pastePrompt.sessionId);
            controller?.writePaste(pastePrompt.text);
            controller?.focus();
          }}
          onCancel={() => {
            setPastePrompt(null);
            getController(pastePrompt.sessionId)?.focus();
          }}
        />
      )}

      {clipboardPrompt && (
        <ClipboardWriteDialog
          key={clipboardPrompt.sessionId}
          session={clipboardTab ? tabTitle(clipboardTab) : t("clipboard.unknownSession")}
          text={clipboardPrompt.text}
          onAllow={(always) => {
            const { sessionId, text } = clipboardPrompt;
            setClipboardPrompt(null);
            if (always) setProgramClipboard("allow");
            const controller = getController(sessionId);
            controller?.allowProgramClipboard(text);
            controller?.focus();
          }}
          onDeny={() => {
            setClipboardPrompt(null);
            getController(clipboardPrompt.sessionId)?.focus();
          }}
        />
      )}

      {authPrompt && (
        <AuthPromptDialog
          key={authPrompt.id}
          prompt={authPrompt}
          onDone={() => clearAuthPrompt(authPrompt.id)}
        />
      )}

      {hostKeyPrompt && (
        <HostKeyDialog
          prompt={hostKeyPrompt}
          onAccept={() => acceptHostKey(hostKeyPrompt)}
          onCancel={() => declineHostKey(hostKeyPrompt)}
        />
      )}

      {sshConfigImport && (
        <SshConfigImportDialog
          key={sshConfigImport.path}
          preview={sshConfigImport}
          onClose={() => setSshConfigImport(null)}
        />
      )}

      {snippetsUi.surfaces}

      {fontSettingsOpen && (
        <FontSizeDialog
          panelFontSize={panelFontSize}
          bufferFontSize={bufferFontSize}
          panelFontFamily={panelFontFamily}
          bufferFontFamily={bufferFontFamily}
          terminalScrollback={terminalScrollback}
          lineHeight={lineHeight}
          cursorStyle={cursorStyle}
          cursorBlink={cursorBlink}
          gpuRenderer={gpuRenderer}
          onApply={(settings) => {
            setPanelFontSize(settings.panelFontSize);
            setBufferFontSize(settings.bufferFontSize);
            setPanelFontFamily(settings.panelFontFamily);
            setBufferFontFamily(settings.bufferFontFamily);
            setTerminalScrollback(settings.terminalScrollback);
            setLineHeight(settings.lineHeight);
            setCursorStyle(settings.cursorStyle);
            setCursorBlink(settings.cursorBlink);
            setGpuRenderer(settings.gpuRenderer);
            setFontSettingsOpen(false);
          }}
          onClose={() => setFontSettingsOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onDisplaySettings={() => setFontSettingsOpen(true)}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsDialog
          bindings={shortcuts}
          onApply={(bindings) => {
            setShortcuts(bindings);
            setShortcutsOpen(false);
          }}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {aboutOpen && (
        <ModalDialog
          open
          onClose={() => setAboutOpen(false)}
          title={t("about.title")}
          labelledBy="about-title"
          contentClassName="about-dialog"
        >
          <div className="dialog-body" style={{ lineHeight: 1.7 }}>
            <strong>EdgeTerm{updater.appVersion ? ` ${updater.appVersion}` : ""}</strong>
            <span>{t("about.tagline")}</span>
            <span style={{ color: "var(--fg-faint)" }}>
              {t("about.madeBy")}{" "}
              <a
                className="about-link"
                href={UPSTREAM_REPOSITORY_URL}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(UPSTREAM_REPOSITORY_URL);
                }}
              >
                github.com/miskin-lee/EdgeTerm
              </a>
            </span>
            <span>
              {t("about.distribution")}{" "}
              <a
                className="about-link"
                href={REPOSITORY_URL}
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(REPOSITORY_URL);
                }}
              >
                github.com/sonwe1e/EdgeTerm
              </a>
            </span>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={() => setAboutOpen(false)}>
              {t("common.close")}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
