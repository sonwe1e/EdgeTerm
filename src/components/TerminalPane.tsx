import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { ensureController, openSessionGit, revealCwdInFiler } from "../actions";
import { zoomFontSize } from "../fontZoom";
import { fontStack } from "../fonts";
import { IS_MAC } from "../platform";
import { chordLabel, type ShortcutCommand } from "../shortcuts";
import { useStore, type Tab } from "../store";
import type { TerminalController } from "../terminal";
import { getController } from "../terminalRegistry";
import { isFileSession } from "../types";
import { useT } from "../useT";
import { commandHistory } from "../history";
import {
  requestSnippetRun,
  requestSnippetSave,
  requestSnippetsOpen,
  sendCommandText,
} from "../snippetActions";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./icons";

// The dual-pane file workspace only exists for FTP and SFTP tabs, so it loads
// with the first one instead of with the window.
const FtpPane = lazy(() => import("./FtpPane").then((module) => ({ default: module.FtpPane })));

interface Props {
  tab: Tab;
  /** Shown in its pane: the tab its strip has selected. */
  visible: boolean;
  /** The active tab of the active pane, which is where keys go. */
  focused: boolean;
  /** Where the pane sits in the workspace; see `Workspace`. */
  style: CSSProperties;
}

/** The user-configurable accelerator for `command`, as a menu writes it. */
export const useAccelerator = (command: ShortcutCommand): string =>
  useStore((s) => chordLabel(s.shortcuts[command]));

// Memoized: a tab switch or another tab's command state changes the tab list,
// and every pane used to re-render with it. Only a pane whose own tab,
// visibility, focus or box changed has anything new to show.
export const SessionPane = memo(function SessionPane({ tab, visible, focused, style }: Props) {
  const setActive = useStore((s) => s.setActive);
  const id = tab.info.id;

  // A press or keyboard focus anywhere in the pane makes its session the
  // active one — menus, the Filer and the Sender follow it — the way a
  // click in a VS Code editor group focuses that group. Capture phase, so
  // xterm's own mousedown handling is untouched.
  const claim = (event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    const state = useStore.getState();
    // A focus that lands on the slot itself — F6 entering the region before
    // its controller attached, or a press on the pane's own padding — ends a
    // roving pass in the strip, so the terminal is the intended target again
    // and the controller's arrival must take the keyboard. Focus that lands
    // lower (xterm's textarea) needs no re-arm; doing it there would leave an
    // autofocus frame that a second F6 has to fight. setActive owns the
    // intent, and has to run for the already active tab too, which the old
    // activeId check skipped.
    const onSlot = event.target === event.currentTarget;
    if (state.activeId !== id || (state.tabFocusTarget !== "terminal" && onSlot)) {
      setActive(id, "terminal");
    }
  };

  return (
    <div
      className={`pane-slot${visible ? "" : " is-hidden"}`}
      style={style}
      role="tabpanel"
      aria-labelledby={`tab-${id}`}
      data-focus-region={focused ? "terminal" : undefined}
      tabIndex={focused ? -1 : undefined}
      onMouseDownCapture={claim}
      onFocusCapture={claim}
    >
      {isFileSession(tab.info.kind) ? (
        <Suspense fallback={null}>
          <FtpPane tab={tab} active={visible} focused={focused} />
        </Suspense>
      ) : (
        <TerminalHost tab={tab} visible={visible} focused={focused} />
      )}
    </div>
  );
});

/** The terminal's right-click menu, with the entries' state when it opened. */
interface TerminalMenu {
  x: number;
  y: number;
  canCopy: boolean;
}

/**
 * Mouse copy / paste, the way terminals conventionally do it: right click
 * follows the `rightClickAction` setting (a context menu, or the Windows
 * console's copy-or-paste on Windows / Linux) and middle click always
 * pastes. Clicks are left alone while a program has enabled mouse
 * reporting, except with Shift held on Windows / Linux, which xterm itself
 * treats as "bypass the program" (macOS has no such key: Option is Meta
 * there).
 */
function TerminalHost({ tab, visible, focused }: { tab: Tab; visible: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const gutterMode = useStore((s) => s.gutterMode);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const lineHeight = useStore((s) => s.lineHeight);
  const bufferFontFamily = useStore((s) => s.bufferFontFamily);
  const symbolFontFamilies = useStore((s) => s.symbolFontFamilies);
  const systemMonoFamily = useStore((s) => s.systemMonoFamily);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const cursorStyle = useStore((s) => s.cursorStyle);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const pasteWarning = useStore((s) => s.pasteWarning);
  const copyOnSelect = useStore((s) => s.copyOnSelect);
  const snippets = useStore((s) => s.snippets);
  const programClipboard = useStore((s) => s.programClipboard);
  const rightClickAction = useStore((s) => s.rightClickAction);
  const [menu, setMenu] = useState<TerminalMenu | null>(null);
  // The pill only exists when it can help: the viewport has left the end.
  const [atBottom, setAtBottom] = useState(true);
  const closeMenu = useCallback(() => setMenu(null), []);
  const id = tab.info.id;
  // xterm loads on demand, so the terminal can arrive a tick after the pane
  // first renders (see ensureController). Effects that looked it up in the
  // registry right away found nothing and silently did nothing — which cost
  // the active tab its `setVisible(true)`, and with it the WebGL renderer and
  // the semantic colors that ride on it. Keeping it in state re-runs them the
  // moment it exists.
  const [terminal, setTerminal] = useState<TerminalController | null>(null);
  const copyKey = useAccelerator("copy");
  const pasteKey = useAccelerator("paste");
  const selectAllKey = useAccelerator("selectAll");
  const clearKey = useAccelerator("clear");
  const revealCwdKey = useAccelerator("revealCwd");

  useEffect(() => {
    if (!terminal) return;
    const off = terminal.onScrollState(setAtBottom);
    setAtBottom(terminal.isAtBottom());
    return off;
  }, [terminal]);

  // Ctrl+wheel is the muscle-memory zoom of every terminal. The listener has
  // to be non-passive to keep the browser from zooming the whole page.
  useEffect(() => {
    // The controller's xterm may not exist yet (lazy import, and jsdom tests
    // that only stub the parts they use).
    const element = terminal?.term?.element;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const store = useStore.getState();
      const next = zoomFontSize(store.bufferFontSize, event.deltaY < 0 ? 1 : -1);
      if (next !== store.bufferFontSize) store.setBufferFontSize(next);
      store.setStatus(t("status.fontSize", { size: next }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [terminal, t]);

  const ownsClick = (event: ReactMouseEvent) => {
    const controller = getController(id);
    if (!controller) return null;
    if (controller.isMouseTracked() && (IS_MAC || !event.shiftKey)) {
      return null;
    }
    return controller;
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const controller = ownsClick(event);
    if (!controller) return;
    event.preventDefault();
    if (rightClickAction === "copyPaste") {
      // PuTTY: with Copy on Select the selection is on the clipboard
      // already, so the right button only ever pastes — copying it again
      // would take a second right click to paste (issue #66).
      if (copyOnSelect) {
        controller.pasteFromClipboard();
        return;
      }
      // conhost / Windows Terminal: the selection is consumed by the copy.
      if (controller.copySelection()) controller.clearSelection();
      else controller.pasteFromClipboard();
      return;
    }
    setMenu({
      x: event.clientX,
      y: event.clientY,
      canCopy: controller.hasSelection(),
    });
  };

  // Middle click: xterm positions its textarea under the pointer so a
  // browser's native primary-selection paste (Linux) lands in the terminal.
  // That would double up with ours, so both the mouseup and the auxclick
  // default actions are cancelled and the clipboard is pasted explicitly.
  const onMiddleButton = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    const controller = ownsClick(event);
    if (!controller) return;
    event.preventDefault();
    if (event.type === "auxclick") {
      controller.focus();
      controller.pasteFromClipboard();
    }
  };

  // Menu entries run after the menu closed; the terminal takes focus back
  // from the clicked entry so a paste lands in it and typing continues.
  const withTerminal = (fn: (controller: TerminalController) => void) => () => {
    const controller = getController(id);
    if (!controller) return;
    controller.focus();
    fn(controller);
  };

  // Read when the pane draws its menu: the list is what the reader reached for
  // most recently, and the menu is rebuilt each time it opens.
  const recentCommands = commandHistory.recent(10).map((entry) => entry.command);

  const menuItems: MenuItem[] = [
    {
      label: t("menu.copy"),
      icon: "copy",
      shortcut: copyKey,
      disabled: !menu?.canCopy,
      action: withTerminal((controller) => controller.copySelection()),
    },
    {
      label: t("menu.paste"),
      icon: "clippy",
      shortcut: pasteKey,
      action: withTerminal((controller) => controller.pasteFromClipboard()),
    },
    {
      label: t("menu.selectAll"),
      icon: "list-selection",
      shortcut: selectAllKey,
      action: withTerminal((controller) => controller.selectAll()),
    },
    "separator",
    {
      label: t("menu.clearBuffer"),
      icon: "clear-all",
      shortcut: clearKey,
      action: withTerminal((controller) => controller.clear()),
    },
    "separator",
    {
      label: t("menu.revealCwdInFiler"),
      icon: "folder-opened",
      shortcut: revealCwdKey,
      action: withTerminal(() => void revealCwdInFiler(id)),
    },
    {
      label: t("git.title"),
      icon: "source-control",
      disabled: tab.state !== "connected" || !["local", "ssh"].includes(tab.info.kind),
      action: withTerminal(() => void openSessionGit(id)),
    },
    // Saved commands, where the shell is: a reader who is about to type a
    // command should not have to leave the terminal to run one they kept.
    ...(snippets.length > 0
      ? [
          "separator" as const,
          {
            label: t("terminal.sendSavedCommand"),
            icon: "book" as const,
            disabled: tab.state !== "connected",
            children: snippets.slice(0, 15).map((snippet) => ({
              label: snippet.name,
              title: snippet.command,
              action: () => requestSnippetRun(snippet),
            })),
          },
          {
            label: t("palette.saveSnippet"),
            icon: "save" as const,
            disabled: tab.state !== "connected",
            action: () => requestSnippetSave(),
          },
          {
            label: t("palette.openSnippets"),
            icon: "book" as const,
            action: () => requestSnippetsOpen(),
          },
        ]
      : [
          "separator" as const,
          {
            label: t("palette.saveSnippet"),
            icon: "save" as const,
            disabled: tab.state !== "connected",
            action: () => requestSnippetSave(),
          },
          {
            label: t("palette.openSnippets"),
            icon: "book" as const,
            action: () => requestSnippetsOpen(),
          },
        ]),
    // Recent commands sit beside the saved ones: a command that worked a
    // minute ago is more often sent again than saved first.
    ...(recentCommands.length > 0
      ? [
          "separator" as const,
          {
            label: t("menu.recentCommands"),
            icon: "history" as const,
            disabled: tab.state !== "connected",
            children: recentCommands.map((command) => ({
              label: command,
              title: command,
              action: () => sendCommandText(command),
            })),
          },
        ]
      : []),
  ];

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // The terminal already exists by the time a session is open; this only
    // waits when the xterm module is still on its way (see ensureController).
    let live = true;
    void ensureController(id).then((controller) => {
      if (!live) return;
      controller.attach(element);
      setTerminal(controller);
    });
    return () => {
      live = false;
    };
  }, [id]);

  // TerminalController observes the actual fit host, including changes from
  // this pane and from the gutter. Observing the outer pane again duplicates
  // layout reads for each splitter/window resize. Its observer skips hidden
  // terminals; the visibility effect below refits on return.

  useEffect(() => {
    terminal?.setGutterMode(gutterMode);
  }, [terminal, gutterMode]);

  useEffect(() => {
    terminal?.setFontSize(bufferFontSize);
  }, [bufferFontSize, terminal]);

  useEffect(() => {
    terminal?.setLineHeight(lineHeight);
  }, [lineHeight, terminal]);

  useEffect(() => {
    terminal?.setFontFamily(
      fontStack("mono", bufferFontFamily, symbolFontFamilies, systemMonoFamily),
    );
  }, [bufferFontFamily, symbolFontFamilies, systemMonoFamily, terminal]);

  useEffect(() => {
    terminal?.setScrollback(terminalScrollback);
  }, [terminal, terminalScrollback]);

  useEffect(() => {
    terminal?.setCursor(cursorStyle, cursorBlink);
  }, [terminal, cursorStyle, cursorBlink]);

  useEffect(() => {
    terminal?.setSuggestions(suggestionsEnabled);
  }, [terminal, suggestionsEnabled]);

  useEffect(() => {
    terminal?.setPasteWarning(pasteWarning);
  }, [terminal, pasteWarning]);

  useEffect(() => {
    terminal?.setCopyOnSelect(copyOnSelect);
  }, [terminal, copyOnSelect]);

  useEffect(() => {
    terminal?.setProgramClipboard(programClipboard);
  }, [terminal, programClipboard]);

  useEffect(() => {
    terminal?.setRightClickAction(rightClickAction);
  }, [terminal, rightClickAction]);

  useEffect(() => {
    if (!terminal) return;
    // The terminal keeps its WebGL renderer for the tabs shown recently
    // and gives it up for the rest; see TerminalController.setVisible.
    terminal.setVisible(visible);
    if (!visible) return;
    // The pane is hidden while its strip shows another tab, so it can only
    // be measured once it is on screen again.
    const frame = requestAnimationFrame(() => terminal.fit(true));
    return () => cancelAnimationFrame(frame);
  }, [visible, terminal]);

  const autoFocus = useStore((s) => s.tabFocusTarget === "terminal") && focused;

  // Roving keys select the tab but leave focus in the strip. The activation
  // target also applies when the controller arrives after a lazy mount.
  useEffect(() => {
    if (!terminal || !autoFocus) return;
    // Where focus was when this autofocus was scheduled. If the reader moved it
    // somewhere else before the frame lands — onto a tab, a menu, a field — that
    // move was deliberate and outranks this convenience. Without this the
    // pending frame steals the keyboard from the strip, and F2 (a strip key)
    // silently stops working whenever a terminal attaches a frame later.
    const before = document.activeElement;
    const frame = requestAnimationFrame(() => {
      // Autofocus is a convenience, never stronger than a field the user is
      // already typing in — renaming a tab must not lose its keystrokes to
      // the terminal arriving a moment later. The terminal's own hidden
      // textarea is not such a field; it is where focus belongs.
      const active = document.activeElement;
      if (
        active?.closest("input, textarea, select") &&
        !active.closest(".xterm, .xterm-helper-textarea")
      ) {
        return;
      }
      if (active !== before && active !== document.body) return;
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, terminal]);

  return (
    <>
      <div
        ref={ref}
        className="term-pane"
        onContextMenu={onContextMenu}
        onMouseUp={onMiddleButton}
        onAuxClick={onMiddleButton}
      />
      {!atBottom && (
        // A jump, not a mode: mousedown is swallowed so the click cannot
        // pull focus out of the terminal.
        <button
          type="button"
          className="term-jump-latest"
          title={t("terminal.jumpToLatest")}
          aria-label={t("terminal.jumpToLatest")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            terminal?.scrollToBottom();
            terminal?.focus();
          }}
        >
          <Icon name="arrow-down" />
          <span>{t("terminal.jumpToLatest")}</span>
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </>
  );
}
