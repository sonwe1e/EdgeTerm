import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import { TerminalClipboard } from "./terminalClipboard";
import { CwdAttribution, createFileLinkProvider } from "./terminalFileLinks";
import { TerminalColdHistory } from "./terminalHistoryIntegration";
import { TerminalCommands } from "./terminalCommands";
import { TerminalGpuRenderer } from "./terminalGpuRenderer";
import { TerminalKeyboard } from "./terminalKeyboard";
import { TerminalLineGutter } from "./terminalLineGutter";
import { TerminalSearchController } from "./terminalSearchController";
import { TerminalSemanticRenderer } from "./terminalSemanticRenderer";
import {
  Callbacks,
  CursorStyle,
  GutterMode,
  ReportedCwd,
  RightClickAction,
  XTERM_THEMES,
  parseOsc1337,
  parseOsc7,
  parseOsc9,
} from "./terminalShared";
import { terminalWebLinkHandler } from "./terminalShared";
import { TerminalViewport } from "./terminalViewport";
export { parseOsc1337, parseOsc7, parseOsc9 } from "./terminalShared";
export type { CursorStyle, GutterMode, ReportedCwd, RightClickAction } from "./terminalShared";

import { createOutputDecoder } from "./encodings";
import { MONO_FONT_FAMILY } from "./fonts";
import { t as translate } from "./i18n";
import { patchImeInput } from "./imePatch";
import { parseOsc52, type ProgramClipboardMode } from "./osc52";
import { setSemanticColorTheme } from "./semanticColors";
import { selectionEdit } from "./terminalSelectionEdit";
import { terminalColdHistoryEnabled } from "./storePreferences";
import { DEFAULT_FIND_OPTIONS, type FindOptions, type SearchResults } from "./terminalSearch";
import { type TransferNoticeKind } from "./terminalTransfer";
import type { BackspaceKey, ThemeMode } from "./types";
import { ZmodemController } from "./zmodem";

/**
 * Owns one xterm.js instance plus the WindTerm-style gutter that runs down the
 * left edge showing a timestamp and line number for every row.
 *
 * The gutter is plain DOM updated on xterm's render tick rather than React
 * state, because it changes on every frame of scrolling output.
 */
export class TerminalController {
  /** Invalidates delayed UI input across disconnect/reconnect. */
  connectionRevision = 0;
  agentKeyPassthrough = false;
  private outputBytes = 0;
  private parseMs = 0;
  private readonly keyboard: TerminalKeyboard;
  /** Only the synchronous xterm wheel dispatch may translate its fallback keys. */
  private dispatchingWheel = false;

  private readonly searchController: TerminalSearchController;

  /**
   * Find `query` in the buffer and highlight every match. `incremental`
   * keeps the current match selected while the query is still being typed,
   * instead of jumping to the next one. An empty query only drops the
   * highlights; a Find in Selection range stays.
   */
  search(
    query: string,
    forward = true,
    incremental = false,
    options: FindOptions = DEFAULT_FIND_OPTIONS,
  ) {
    return this.searchController.search(query, forward, incremental, options);
  }

  /** Fires after every search and when output has moved the matches. */
  onSearchResults(listener: (results: SearchResults) => void) {
    return this.searchController.onSearchResults(listener);
  }

  /**
   * Find in Selection: search only the current selection (or, when a search
   * has since moved the selection to a match, the one the user made). False
   * when there is no selection to search in.
   */
  setSearchScope(on: boolean): boolean {
    return this.searchController.setSearchScope(on);
  }

  /** Drop the match highlights and the range; also stops re-searching on every write. */
  clearSearch() {
    return this.searchController.clearSearch();
  }

  private readonly clipboard: TerminalClipboard;

  hasSelection(): boolean {
    return this.clipboard.hasSelection();
  }

  copySelection(): boolean {
    return this.clipboard.copySelection();
  }

  selectAll() {
    return this.clipboard.selectAll();
  }

  clearSelection() {
    return this.clipboard.clearSelection();
  }

  setRightClickAction(action: RightClickAction) {
    return this.clipboard.setRightClickAction(action);
  }

  pasteFromClipboard() {
    return this.clipboard.pasteFromClipboard();
  }

  paste(text: string) {
    return this.clipboard.paste(text);
  }

  writePaste(text: string) {
    return this.clipboard.writePaste(text);
  }

  setPasteWarning(enabled: boolean) {
    return this.clipboard.setPasteWarning(enabled);
  }

  setCopyOnSelect(enabled: boolean) {
    return this.clipboard.setCopyOnSelect(enabled);
  }

  setProgramClipboard(mode: ProgramClipboardMode) {
    return this.clipboard.setProgramClipboard(mode);
  }

  onConfirmClipboardWrite(confirm: (text: string) => void) {
    return this.clipboard.onConfirmClipboardWrite(confirm);
  }

  allowProgramClipboard(text: string) {
    return this.clipboard.allowProgramClipboard(text);
  }

  onConfirmPaste(confirm: (text: string) => void) {
    return this.clipboard.onConfirmPaste(confirm);
  }

  isMouseTracked(): boolean {
    return this.clipboard.isMouseTracked();
  }

  private readonly commands: TerminalCommands;

  noteCommandSent(command?: string) {
    return this.commands.noteCommandSent(command);
  }

  waitForCommand(timeoutMs: number): Promise<void> {
    return this.commands.waitForCommand(timeoutMs);
  }

  cancelCommandSent() {
    return this.commands.cancelCommandSent();
  }

  private readonly lineGutter: TerminalLineGutter;

  private readonly viewport: TerminalViewport;

  fit(immediate = false): { cols: number; rows: number } | null {
    const fitted = this.viewport.fit(immediate);
    // xterm's fit can clear a DOM fallback before its hidden resize resumes.
    this.gpu.paintFallback();
    return fitted;
  }

  scheduleFit() {
    return this.viewport.scheduleFit();
  }

  private readonly gpu: TerminalGpuRenderer;

  refreshWebgl() {
    return this.gpu.refreshWebgl();
  }

  private readonly semantic: TerminalSemanticRenderer;

  readonly term: Terminal;
  readonly fitAddon = new FitAddon();
  private readonly zmodem: ZmodemController;
  private readonly coldHistory: TerminalColdHistory;
  /**
   * Decodes session output when the session is not in UTF-8, the only
   * encoding xterm reads itself; null feeds xterm the bytes as they are.
   */
  private decoder: TextDecoder | null = null;
  /** The erase character Backspace sends; see `setBackspace`. */
  private erase = "\x7f";
  private readonly transferNotice: HTMLElement;
  private readonly transferNoticeText: HTMLElement;
  private readonly transferCancel: HTMLButtonElement;
  private transferNoticeTimer: number | null = null;
  /**
   * A font change made while the pane was display:none, landed at the show
   * boundary where the renderer can measure it; see setFontSize.
   */
  private pendingFont: { size?: number; family?: string } | null = null;
  /**
   * Watches the fit parent itself: the gutter widening after its rows first
   * paint (or a font-size change) shrinks the host the fit measured, and the
   * pane-level observer cannot see that. One observer per terminal, no
   * polling.
   */
  private hostResize: ResizeObserver | null = null;

  private root: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private gutter: HTMLElement | null = null;
  /** Set by an ED 3 until its write chunk ends; see the CSI J handler. */
  private shellClearing = false;

  private gutterMode: GutterMode = "both";
  private themeMode: ThemeMode;
  private scrollback: number;
  private locked = false;
  /** Command history capture + completion popup. Opt-in via the Edit menu. */
  private suggestionsOn = false;
  /** A viewport pass is queued for the end of the current task; see onScroll. */
  private viewportSyncQueued = false;
  /** Width at the last resize, to tell a reflow from a height-only change. */
  private lastCols = 0;
  /** The shell's latest OSC directory report; see `reportedCwd`. */
  private reported: ReportedCwd | null = null;
  /**
   * Which directory was in effect for which line of output, for the file links
   * printed by commands; see CwdAttribution and contentLine below.
   */
  private readonly cwdLines = new CwdAttribution();
  private disposed = false;
  /** True while the pane is on screen; see setVisible. */
  private visible = false;

  constructor(
    readonly sessionId: string,
    private readonly callbacks: Callbacks,
    fontSize: number,
    scrollback: number,
    theme: ThemeMode = "dark",
    fontFamily: string = MONO_FONT_FAMILY,
  ) {
    const owner = this;
    this.scrollback = scrollback;
    this.themeMode = theme;
    // The semantic palette and the engine that reads a line are module-level
    // state in semanticColors.ts, and this is the first place in the terminal
    // bundle that knows the theme: App only owns the CSS variables, so that
    // module (and serialX's highlighter behind it) never reaches the shell.
    setSemanticColorTheme(theme);
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily,
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback,
      theme: XTERM_THEMES[theme],
      // VS Code's approach to palette legibility: rather than hand-tuning
      // every ANSI entry per background, let the renderer nudge foregrounds
      // that fall below 4.5:1 against the current background.
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      // xterm's default, stated so a future upstream change cannot quietly
      // take Alt+click away: on mouseup it walks the shell's cursor to the
      // clicked cell with arrow-key sequences (wide characters and wrapped
      // lines included), and leaves programs that track the mouse alone.
      altClickMovesCursor: true,
      // Kept in step with the right-click setting by setRightClickAction:
      // only the menu mode wants the word under the pointer selected first.
      rightClickSelectsWord: true,
    });
    this.keyboard = new TerminalKeyboard({
      get agentKeyPassthrough() {
        return owner.agentKeyPassthrough;
      },
      get commands() {
        return owner.commands;
      },

      get term() {
        return owner.term;
      },

      get erase() {
        return owner.erase;
      },

      get locked() {
        return owner.locked;
      },

      get clipboard() {
        return owner.clipboard;
      },
    });

    this.searchController = new TerminalSearchController({
      get term() {
        return owner.term;
      },

      get themeMode() {
        return owner.themeMode;
      },
    });

    this.clipboard = new TerminalClipboard({
      get host() {
        return owner.host;
      },

      get disposed() {
        return owner.disposed;
      },

      get locked() {
        return owner.locked;
      },

      get commandRunning() {
        return owner.commands.commandRunning;
      },

      get term() {
        return owner.term;
      },

      get showTransferNotice() {
        return (...args: Parameters<typeof owner.showTransferNotice>) =>
          owner.showTransferNotice(...args);
      },
    });

    this.commands = new TerminalCommands({
      get disposed() {
        return owner.disposed;
      },

      get locked() {
        return owner.locked;
      },

      get isTransferActive() {
        return (...args: Parameters<typeof owner.isTransferActive>) =>
          owner.isTransferActive(...args);
      },
      get term() {
        return owner.term;
      },

      get callbacks() {
        return owner.callbacks;
      },

      get suggestionsOn() {
        return owner.suggestionsOn;
      },

      get host() {
        return owner.host;
      },

      get lineGutter() {
        return owner.lineGutter;
      },

      get erase() {
        return owner.erase;
      },
    });

    this.lineGutter = new TerminalLineGutter({
      get gutter() {
        return owner.gutter;
      },

      get gutterMode() {
        return owner.gutterMode;
      },

      get agentSessionActive() {
        return owner.commands.aiTool !== null;
      },

      get term() {
        return owner.term;
      },

      get scrollback() {
        return owner.scrollback;
      },

      get host() {
        return owner.host;
      },
    });

    const resizeTerminal = this.term.resize.bind(this.term);
    this.term.resize = (cols, rows) =>
      this.lineGutter.resize(cols, () => resizeTerminal(cols, rows));

    this.viewport = new TerminalViewport({
      get disposed() {
        return owner.disposed;
      },

      get visible() {
        return owner.visible;
      },

      get host() {
        return owner.host;
      },

      get fitAddon() {
        return owner.fitAddon;
      },

      get term() {
        return owner.term;
      },

      get cellHeight() {
        return owner.lineGutter.cellHeight;
      },

      get measureCell() {
        return (...args: Parameters<typeof owner.lineGutter.measureCell>) =>
          owner.lineGutter.measureCell(...args);
      },
      get invalidateGutter() {
        return (...args: Parameters<typeof owner.lineGutter.invalidateGutter>) =>
          owner.lineGutter.invalidateGutter(...args);
      },
      get syncGutter() {
        return (...args: Parameters<typeof owner.lineGutter.syncGutter>) =>
          owner.lineGutter.syncGutter(...args);
      },
      get inputAnchor() {
        return owner.commands.inputAnchor;
      },

      get candidates() {
        return owner.commands.candidates;
      },

      get schedulePopupSync() {
        return (...args: Parameters<typeof owner.commands.schedulePopupSync>) =>
          owner.commands.schedulePopupSync(...args);
      },
    });

    this.gpu = new TerminalGpuRenderer({
      get disposed() {
        return owner.disposed;
      },

      get host() {
        return owner.host;
      },

      get term() {
        return owner.term;
      },

      get sessionId() {
        return owner.sessionId;
      },

      get visible() {
        return owner.visible;
      },
    });

    this.semantic = new TerminalSemanticRenderer({
      get term() {
        return owner.term;
      },

      get visible() {
        return owner.visible;
      },

      get disposed() {
        return owner.disposed;
      },
    });

    this.transferNotice = document.createElement("div");
    this.transferNotice.className = "transfer-notice is-hidden";
    this.transferNotice.setAttribute("role", "status");
    this.transferNotice.setAttribute("aria-live", "polite");
    // An automatic ZMODEM transfer is started by the remote (sz/rz), so the
    // notice is the only surface it owns. It carries the cancel control: a
    // peer that never finishes would otherwise hold the byte stream until
    // the session ends.
    this.transferNoticeText = document.createElement("span");
    this.transferNoticeText.className = "transfer-notice-text";
    this.transferCancel = document.createElement("button");
    this.transferCancel.type = "button";
    this.transferCancel.className = "transfer-notice-cancel";
    this.transferCancel.textContent = translate("common.cancel");
    this.transferCancel.hidden = true;
    this.transferCancel.addEventListener("click", () => this.cancelTransfer());
    this.transferNotice.append(this.transferNoticeText, this.transferCancel);

    const transferCallbacks = {
      toTerminal: (bytes: Uint8Array) => this.feed(bytes),
      onStatus: callbacks.onStatus,
      onNotice: (message: string, kind: TransferNoticeKind) =>
        this.showTransferNotice(message, kind),
    };
    this.zmodem = new ZmodemController(sessionId, transferCallbacks);
    // Seamless cold history (A2, D14): inert until the preference is on; the
    // capture starts with the first parsed write after that.
    this.coldHistory = new TerminalColdHistory({
      terminal: this.term,
      sessionId,
      enabled: () => terminalColdHistoryEnabled(),
      onPrepended: (rows) => {
        // The re-inserted rows predate the current first line number.
        this.lineGutter.firstLineNumber -= rows;
        this.lineGutter.invalidateGutter();
      },
      onNotice: (text) => this.callbacks.onStatus?.(`cold history: ${text}`),
    });

    this.term.loadAddon(this.fitAddon);
    // The handler carries the session into the click: an SSH terminal's
    // loopback link is opened through a tunnel to that server, not to this
    // machine's own localhost.
    this.term.loadAddon(new WebLinksAddon(terminalWebLinkHandler(this.callbacks)));
    // File paths printed by commands, opened in the built-in editor on
    // Ctrl+click. A relative path belongs to the directory the shell was in
    // when that line was printed, which is why the reports are kept per line
    // rather than read as "the current directory" at click time.
    this.term.registerLinkProvider(
      createFileLinkProvider({
        terminal: this.term,
        getCwdForLine: (bufferLineNumber) =>
          this.cwdLines.resolve(this.contentLine(bufferLineNumber - 1)),
        openLink: (target) => this.callbacks.onFileLink?.(target.path, target.line, target.cwd),
        isMouseTracking: () => this.clipboard.isMouseTracked(),
      }),
    );
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    // A file transfer owns the byte stream while it is active. Forwarding
    // keystrokes or paste data in the middle of a binary frame corrupts it.
    this.term.onData((data) => this.handleData(data));
    this.term.attachCustomWheelEventHandler(() => {
      // Keep xterm's delta accumulation, trackpad filtering and mouse reports.
      // Its no-mouse fallback emits an arrow synchronously in this dispatch.
      this.dispatchingWheel = true;
      queueMicrotask(() => {
        this.dispatchingWheel = false;
      });
      return true;
    });
    // xterm sends legacy mouse reports, including wheel events, through
    // onBinary. Coordinates above 95 become bytes above 127: UTF-8 encoding
    // would corrupt them.
    this.term.onBinary((data) => {
      if (this.locked || this.isTransferActive()) return;
      this.callbacks.onBinary?.(Uint8Array.from(data, (char) => char.charCodeAt(0)));
    });
    // Shells with OSC 7 / 1337 / 9;9 integration announce their working
    // directory at every prompt. Only the latest report is kept: it answers
    // "Reveal Working Directory in Filer" exactly, nested shells and sudo
    // included, wherever the OS or the server cannot be asked.
    const report = (parse: (data: string) => ReportedCwd | null) => (data: string) => {
      const cwd = parse(data);
      if (cwd) {
        const changed = this.reported?.path !== cwd.path || this.reported?.host !== cwd.host;
        this.reported = cwd;
        // A report is printed at the prompt, so it covers the output above it
        // that was already written: record the line the prompt sits on. A
        // full-screen program's buffer has no lines to attribute.
        const buffer = this.term.buffer.active;
        if (buffer.type === "normal") {
          this.cwdLines.record(this.contentLine(buffer.baseY + buffer.cursorY), cwd.path);
        }
        // Followers (the Filer's terminal follow) only want real moves: a
        // prompt that reports the same directory on every Enter must not
        // reload the listing.
        if (changed) this.callbacks.onReportedCwd?.(cwd);
        // These reports are conventionally emitted by a prompt hook. They
        // also cover visually empty/custom prompts that cannot be matched
        // from buffer text alone.
        this.commands.finishCommand();
      }
      return cwd !== null;
    };
    this.term.parser.registerOscHandler(7, report(parseOsc7));
    this.term.parser.registerOscHandler(1337, report(parseOsc1337));
    this.term.parser.registerOscHandler(9, report(parseOsc9));
    // tmux, vim and TUI agents copy with OSC 52 (issue #65). Always claimed,
    // so a request that is not written (a `?` read, a denied write) is not
    // passed on to anything else.
    this.term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text !== null) this.clipboard.programClipboardWrite(text);
      return true;
    });
    // OpenCode and other agents can report their own state. Idle redraws
    // and prompt editing must not override these reports with byte activity.
    this.term.parser.registerOscHandler(7501, (data) => this.commands.reportProgramStatus(data));
    this.term.parser.registerEscHandler({ final: "c" }, () => {
      this.commands.resetProgramStatus();
      return false; // Let xterm perform the full terminal reset as well.
    });
    // FinalTerm/iTerm shell integration brackets commands with OSC 133. It
    // is the authoritative completion signal when available; prompt matching
    // below covers ordinary bash/zsh/fish/cmd/PowerShell installations.
    this.term.parser.registerOscHandler(133, (data) => {
      const marker = data.split(";", 1)[0];
      if (marker === "C" && !this.commands.commandRunning) this.commands.beginCommand();
      else if (marker === "D" || marker === "A") this.commands.finishCommand();
      return marker === "A" || marker === "B" || marker === "C" || marker === "D";
    });
    // A shell's `clear` restarts the line numbering and drops the scrollback,
    // the way WindTerm does. It is ED 2 paired with ncurses 6's ED 3 — after
    // it on Linux (`\e[H\e[2J\e[3J`), before it on macOS (`\e[3J\e[H\e[2J`) —
    // and that pairing is the whole signal: a bare ED 2 belongs to a
    // full-screen program painting in the normal buffer (Linux top, anything
    // under a TERM without smcup), and wiping the buffer for it threw away
    // the session's history the moment top started (issue #43). Those erases
    // push the screen into the scrollback instead, as PuTTY does, so nothing
    // that was on screen is ever lost.
    //
    // Both run right here, while the sequence is being parsed and before
    // xterm's own erase: top clears the screen and draws its frame in the
    // same chunk, and clearing after the chunk had parsed wiped that frame,
    // so top showed nothing until its next refresh (issue #32). The handler
    // falls through so xterm still erases.
    this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
      const normal = this.term.buffer.active.type === "normal";
      const mode = params[0];
      if (mode === 2) {
        // The alternate screen has no scrollback to push to, and a program
        // erasing inside a scroll region there expects the plain erase.
        this.term.options.scrollOnEraseInDisplay = normal && !this.shellClearing;
        if (normal) this.screenCleared();
      } else if (mode === 3 && normal) {
        this.shellClearing = true;
        this.scrollbackErased();
      }
      return false;
    });
    this.term.buffer.onBufferChange((buffer) => {
      // Normal scrollback is covered by a full-screen program. Keep its
      // deferred coloring for the return instead of repeatedly walking it
      // between the program's redraws.
      if (buffer.type === "alternate") this.semantic.stopBacklog();
      else if (this.visible) this.semantic.scheduleBacklog();
    });
    this.term.onWriteParsed(() => {
      this.lineGutter.outputParsed();
      this.coldHistory.outputParsed();
      // New output: xterm has updated the buffer and queued its repaint but
      // not painted yet, so cells painted here show in that same frame. Coloring only from `onRender` (which fires *after* the
      // renderer has drawn) showed every freshly written row plain for one
      // frame before it was recolored — a visible flash on `ls -la`.
      //
      // This fires once per parse slice (xterm parses for up to 12 ms, then
      // yields), so during an output flood it runs about once per frame and
      // takes over the work the `onRender` pass would otherwise do; that
      // pass then finds the rows unchanged and costs a viewport of string
      // compares. Two slices in one frame cost one extra viewport of regex
      // work (~0.5 ms); a throttle would bring back a half-viewport flash
      // when a listing arrives split across slices, so there is none.
      //
      // A hidden terminal paints nothing: its viewport is not on screen, and
      // `setVisible(true)` colors it before the first frame. Command tracking
      // still runs, since a background tab's busy / done state depends on it.
      if (this.visible) {
        this.semantic.refreshSemanticColors();
        this.semantic.scheduleBacklog();
      }
      this.lineGutter.gutterContentDirty = true;
      this.commands.observeCommandEcho();
      this.commands.detectReturnedPrompt();
      // The shell's echo of a keystroke lands here; recompute the suggestions
      // from the buffer only while the user is composing a command.
      if (this.commands.inputAnchor) this.commands.schedulePopupSync();
      // `clear` sends its two erases in one chunk; a later ED 2 is somebody
      // else's redraw and keeps the scrollback.
      this.shellClearing = false;
    });

    this.lastCols = this.term.cols;
    this.term.onResize(({ cols, rows }) => {
      this.callbacks.onResize(cols, rows);
      // Reflow regroups rows, and a band ends at the width it was painted
      // at; everything is colored again. A change of rows alone (the height
      // of a splitter drag, a diagonal drag's immediate half) reflows nothing,
      // so the painted rows stay as they are.
      const widthChanged = cols !== this.lastCols;
      this.lastCols = cols;
      if (widthChanged) this.semantic.recolorAll();
      // Reflow moves lines between rows; the parked marker's count means
      // nothing across it, so the next pass starts from a fresh one.
      this.lineGutter.resetTrimMarker();
      this.lineGutter.trimLineMetadata();
      this.lineGutter.measureCell();
      this.lineGutter.invalidateGutter();
      this.lineGutter.syncGutter();
      // onResize runs before xterm has laid the resized screen out; the
      // read above can be stale and the re-measure at the boundary corrects
      // it.
      this.viewport.scheduleCellMeasure();
    });

    this.term.onLineFeed(() => this.lineGutter.recordLine());
    this.term.onRender(() => {
      if (!this.visible) return;
      // Catch-all for rows the write and scroll hooks did not see (resize
      // rebuilds, the cursor leaving a line, a second parse slice in the
      // same frame). Runs after the paint, so anything it colors shows up a
      // frame late; in the steady state it finds nothing to do.
      this.semantic.refreshSemanticColors();
      this.lineGutter.syncGutter();
    });
    this.term.onScroll(() => {
      // Fires synchronously while xterm handles the scroll (wheel, scrollbar
      // drag, or its own scrollTop during an output flood), before the
      // repaint it queues. The work is deferred to a microtask: that still
      // runs before the paint, so the colors land in the same frame,
      // but an output flood, which scrolls once per line and fires this
      // thousands of times per parse slice, pays for one viewport pass per
      // slice instead of one per line (per line it throttled `seq 1 300000`
      // to ~10k lines/s). Rows colored here keep their state and are skipped
      // by the `onRender` pass. New output is handled by the `onWriteParsed`
      // hook.
      this.queueViewportSync();
      if (this.commands.inputAnchor || this.commands.candidates.length)
        this.commands.schedulePopupSync();
    });
    this.term.attachCustomKeyEventHandler((event) => this.keyboard.filterKey(event));
    this.term.onSelectionChange(() => {
      this.clipboard.selectionChanged = true;
      this.clipboard.captureAgentSelection();
    });
    // Copy on select (see `onSelectionMouseUp`). The buttons are watched
    // above the host: a selection drag routinely ends outside the terminal,
    // and the mouse up that finishes it is then delivered to whatever is
    // under the pointer. The mouse up is watched on the window, not the
    // document: xterm reports a mouse selection only from its own document
    // mouse up listener, added at each press and so after ours, and on the
    // document ours ran first, saw no selection yet and never copied
    // (issue #70). The window hears the bubbling event after every document
    // listener.
    document.addEventListener("mousedown", this.clipboard.onSelectionMouseDown);
    window.addEventListener("mouseup", this.clipboard.onSelectionMouseUp);

    this.lineGutter.lineTimes.push(Date.now());
  }

  attach(root: HTMLElement) {
    if (this.disposed || this.root === root) return;

    // Re-parenting keeps the existing xterm instance (and its scrollback)
    // alive if React ever hands us a fresh container node.
    if (this.root && this.gutter && this.host) {
      root.replaceChildren(this.gutter, this.host, this.transferNotice);
      this.root = root;
      this.viewport.fit();
      return;
    }

    this.root = root;
    root.replaceChildren();

    this.gutter = document.createElement("div");
    this.gutter.className = "term-gutter";

    this.host = document.createElement("div");
    this.host.className = "term-host";
    this.host.addEventListener("mousemove", this.clipboard.onSelectionMouseMove, true);
    this.hostResize = new ResizeObserver(() => {
      // The entry-level contract: a hidden terminal is never asked to fit
      // (the show path refits explicitly).
      if (this.visible) this.scheduleFit();
    });
    this.hostResize.observe(this.host);

    root.appendChild(this.gutter);
    root.appendChild(this.host);
    root.appendChild(this.transferNotice);

    this.term.open(this.host);
    // Wheel events past the buffer top pull one cold chunk in (A2).
    this.coldHistory.attachWheel(this.term.element ?? null);
    this.viewport.observeDisplayChanges();
    // IME text takes the exactly-once path in imePatch.ts. It hooks the
    // composition helper xterm creates in open(), so it goes right after.
    patchImeInput(this.term, {
      onCompositionStart: () => {
        // Rapid consecutive compositions may share a pending textarea read.
        // Keep its original ownership until all of that text has settled.
        this.imeComposition ??= {
          revision: this.connectionRevision,
          selectionStamp: this.imeSelectionStamp(),
        };
      },
      onCompositionSettled: () => {
        this.imeComposition = null;
      },
      sendText: (text) => this.sendImeText(text),
    });
    // Inside the host (not the root) so the completion popup positions
    // against the terminal content, past the gutter, and survives
    // re-parenting above.
    this.host.appendChild(this.commands.popup);

    // WebGL comes with being shown (setVisible); it needs the host, so a
    // terminal that was shown before it was attached loads it here.
    if (this.visible) this.gpu.loadWebgl();

    this.viewport.fit();
    this.lineGutter.applyGutterMode();
  }

  /** Nothing is deleted while an IME candidate is still tentative. */
  private imeComposition: { revision: number; selectionStamp: string | null } | null = null;

  /** Revalidate the selected input, not just its coordinates, at commit time. */
  private imeSelectionStamp(): string | null {
    if (
      !selectionEdit(this.term, {
        commandRunning: this.commands.commandRunning,
        locked: this.locked,
      })
    )
      return null;
    const buffer = this.term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let first = cursorRow;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    const text: string[] = [];
    for (let row = first; row <= cursorRow; row++)
      text.push(buffer.getLine(row)?.translateToString(false) ?? "");
    return JSON.stringify([
      this.term.cols,
      cursorRow,
      buffer.cursorX,
      this.term.getSelectionPosition(),
      text,
    ]);
  }

  /** Commit delete + replacement + cursor restoration together, without a timer. */
  private sendImeText(text: string) {
    const composition = this.imeComposition;
    if (
      this.disposed ||
      this.locked ||
      this.isTransferActive() ||
      (composition && composition.revision !== this.connectionRevision)
    )
      return;
    const sameSelection =
      !composition ||
      (composition.selectionStamp !== null &&
        composition.selectionStamp === this.imeSelectionStamp());
    // A composition can flush more than once; only its first text replaces
    // the selection. Empty/cancelled compositions never reach this method.
    if (composition) composition.selectionStamp = null;
    const edit = sameSelection
      ? selectionEdit(this.term, {
          commandRunning: this.commands.commandRunning,
          locked: this.locked,
        })
      : null;
    if (edit) this.term.clearSelection();
    this.term.input(edit ? edit.deleteSequence + text + edit.restore : text, true);
  }

  /**
   * Tells the terminal whether its pane is on screen. WebGL is loaded on
   * showing and kept while hidden, so switching back to a recent tab costs
   * nothing; the least recently shown terminals lose theirs past
   * WEBGL_MAX_TERMINALS. An evicted tab first shows its DOM fallback when
   * the pool is full, then reacquires a GPU slot if the visit lasts.
   */
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.viewport.flushDisplayChange();
      // A font change made while hidden lands here, where the renderer can
      // measure it, and before the pane's show refit proposes dimensions.
      const pending = this.pendingFont;
      this.pendingFont = null;
      if (pending?.size !== undefined) {
        this.term.options.fontSize = pending.size;
        this.refreshFontMetrics();
      }
      if (pending?.family !== undefined) {
        this.term.options.fontFamily = pending.family;
        this.refreshFontMetrics();
      }
      this.gpu.loadWebgl();
      // Output that arrived while hidden was not painted; do the viewport now,
      // ahead of the first frame, and the rest in the backlog.
      this.semantic.refreshSemanticColors();
      this.gpu.paintFallback();
      this.lineGutter.syncGutter();
      this.semantic.scheduleBacklog();
    } else {
      this.gpu.suspend();
      this.viewport.suspend();
      this.semantic.stopBacklog();
    }
  }

  write(data: Uint8Array, consumed?: () => void) {
    if (this.disposed) {
      consumed?.();
      return;
    }
    this.outputBytes += data.length;
    // Cheap enough for the byte path: one timestamp, only while a turn is
    // open, and the quiet timer reads it instead of being re-armed here.
    if (this.commands.aiTurn) this.commands.aiOutputAt = Date.now();
    // The ZMODEM sentry watches for its handshake and passes ordinary output
    // through to xterm; while an automatic transfer runs it owns the stream.
    this.zmodem.consume(data);
    // The protocol sentries may emit several decoded writes, or consume the
    // whole chunk themselves. A barrier accounts for the ORIGINAL byte count
    // only after all synchronous terminal output from this chunk is parsed.
    // It also works on hidden terminals, without a render/rAF dependency.
    const began = performance.now();
    this.term.write("", () => {
      this.parseMs = performance.now() - began;
      consumed?.();
    });
  }

  /**
   * Sets the encoding the session's output arrives in (a WHATWG label;
   * UTF-8 or unknown means none). Called for every connect, which also
   * discards a partial character left over from the previous session.
   */
  setEncoding(label: string | null | undefined) {
    this.decoder = createOutputDecoder(label);
  }

  /**
   * Sets what Backspace sends: ^H for the profiles that ask for it (old
   * network gear and serial consoles erase on 0x08 and print ^? for
   * xterm's 0x7f, issue #89), ^? otherwise. Set on every connect, like the
   * encoding, so a re-edited profile takes effect on reconnect.
   */
  setBackspace(key: BackspaceKey | null | undefined) {
    this.erase = key === "controlH" ? "\x08" : "\x7f";
  }

  /**
   * Hands ordinary output — what the transfer sentries let through — to
   * xterm. Only the terminal's own bytes are decoded: the sentries and the
   * transfers behind them need the raw stream, so the conversion has to sit
   * after them, not in `write`.
   */
  private feed(bytes: Uint8Array) {
    if (this.decoder) {
      this.term.write(this.decoder.decode(bytes, { stream: true }));
    } else {
      this.term.write(bytes);
    }
  }

  writeText(text: string) {
    this.term.write(text);
  }

  /**
   * Locks the terminal once its session has ended: keystrokes and paste
   * stay local — except Enter, which asks `onReconnect` to bring the
   * session back — and the cursor is hidden so the pane does not look
   * like it is waiting for input. Unlocking restores both for a
   * reconnect.
   */
  setLocked(locked: boolean) {
    if (this.locked === locked) return;
    this.connectionRevision += 1;
    this.locked = locked;
    if (!locked) {
      // A disconnected TUI cannot send its usual shutdown sequences. Reusing
      // its xterm instance for a fresh shell would otherwise keep mouse
      // tracking (and forward wheel/move reports as literal shell input),
      // application cursor keys, focus reports and bracketed paste enabled.
      // Reset only session-owned modes, retaining the normal scrollback and
      // the previous full-screen image until the user actually reconnects.
      this.term.write("\x1b[?1;1000;1002;1003;1004;1005;1006;1015;2004l\x1b[?1049l\x1b>");
    }
    this.term.write(locked ? "\x1b[?25l" : "\x1b[?25h");
    if (locked) {
      this.agentKeyPassthrough = false;
      this.clipboard.endSession();
      this.commands.hidePopup();
      this.commands.resetCommandTracking();
      // A reconnected shell starts over in its home directory; the old
      // report must not outlive the session it described.
      this.reported = null;
    }
  }

  /**
   * One keystroke or paste from xterm. A file transfer owns the byte
   * stream while it is active, and a locked terminal keeps everything
   * local except Enter — the one key a dead session still answers, which
   * asks `onReconnect` to bring it back the way WindTerm does.
   */
  private handleData(data: string): void {
    if (this.isTransferActive()) return;
    if (this.locked) {
      if (data === "\r") this.callbacks.onReconnect?.();
      return;
    }
    if (
      this.dispatchingWheel &&
      (this.commands.aiTool === "pi" || this.commands.aiTool === "pi-coding-agent") &&
      this.term.buffer.active.type === "alternate" &&
      this.term.modes.mouseTrackingMode === "none" &&
      /^\x1b(?:\[|O)[AB]$/.test(data)
    ) {
      // Pi uses arrows for prompt history. Its fullscreen page keys scroll
      // the transcript (or the focused overlay) without changing the draft.
      // A real key press and other programs retain xterm's normal behavior.
      this.callbacks.onData(data.endsWith("A") ? "\x1b[5~" : "\x1b[6~");
      return;
    }
    this.commands.trackInput(data);
    this.callbacks.onData(data);
  }

  /**
   * One buffer line in the coordinate the file-link attribution records in.
   * xterm renumbers every line when the scrollback drops its oldest, and the
   * gutter's first line number already counts those drops, so the same
   * coordinate survives trimming; the erases that restart the numbering reset
   * the attribution instead (see scrollbackErased/resetLineMetadata).
   */
  private contentLine(bufferIndex: number): number {
    return this.lineGutter.firstLineNumber + bufferIndex;
  }

  /**
   * The working directory the shell last announced through OSC 7 / 1337 /
   * 9;9, or null when it never has (or the session ended since).
   */
  get reportedCwd(): ReportedCwd | null {
    return this.reported;
  }

  agentDiagnostics() {
    return {
      tool: this.commands.aiTool,
      commandRunning: this.commands.commandRunning,
      buffer: this.term.buffer.active.type,
      mouse: this.term.modes.mouseTrackingMode,
      bracketedPaste: this.term.modes.bracketedPasteMode,
      cols: this.term.cols,
      rows: this.term.rows,
      historyRows: this.term.buffer.normal.baseY,
      outputBytes: this.outputBytes,
      parseMs: this.parseMs,
    };
  }

  getAgentSelection(): string {
    return this.clipboard.getAgentSelection();
  }

  /** An explicit composer action: bracketed paste, never an appended Enter. */
  insertAgentPrompt(text: string, revision: number): boolean {
    if (
      revision !== this.connectionRevision ||
      this.disposed ||
      this.locked ||
      this.isTransferActive() ||
      !this.term.modes.bracketedPasteMode
    )
      return false;
    if (text.length > 1024 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return false;
    this.term.paste(text);
    return true;
  }

  /** True while the ZMODEM sentry owns the byte stream. */
  isTransferActive(): boolean {
    return this.zmodem.isActive();
  }

  /**
   * Cancels the automatic ZMODEM transfer; false when none is running. The
   * transfer notice shows this as its Cancel control, the one gesture the
   * automatic handshake has.
   */
  cancelTransfer(): boolean {
    return this.zmodem.cancel();
  }

  focus() {
    this.term.focus();
  }

  clear() {
    this.clearBufferAndMetadata();
  }

  /**
   * ED 2 in the normal buffer: the screen is about to be erased. `clear`'s own
   * erase drops the buffer; every other one keeps it, because xterm is about
   * to push the screen into the scrollback rather than wipe it.
   */
  private screenCleared() {
    if (this.commands.commandRunning) this.commands.commandOutputAdvanced = true;
    if (this.shellClearing) {
      this.clearBufferAndMetadata();
      return;
    }
    // The typed input is about to leave the screen with everything else.
    this.commands.dropAnchor();
    this.followScrollTrim();
  }

  /**
   * The rows xterm is about to push into the scrollback keep their place in
   * the buffer, so the gutter's parallel metadata needs no shifting — unless
   * the buffer is already full, where the same push trims lines off the top
   * and moves every buffer index down. That trim happens without a line feed,
   * which is what `recordLine` would otherwise account for, so the count is
   * worked out here from the rows xterm will scroll (its own rule: everything
   * down to the last row that holds a character).
   */
  private followScrollTrim() {
    const buf = this.term.buffer.active;
    // A screen's worth of headroom left: nothing can be trimmed.
    if (buf.length <= this.scrollback) return;
    this.lineGutter.followTrimmedLines();
    const work = (this.semantic.workCell ??= buf.getNullCell());
    let scrolled = 0;
    for (let row = this.term.rows - 1; row >= 0 && scrolled === 0; row -= 1) {
      const line = buf.getLine(buf.baseY + row);
      if (!line) continue;
      for (let col = line.length - 1; col >= 0; col -= 1) {
        if (line.getCell(col, work)?.getCode()) {
          scrolled = row + 1;
          break;
        }
      }
    }
    this.lineGutter.dropLeadingLines(buf.length + scrolled - (this.term.rows + this.scrollback));
    this.lineGutter.resetTrimMarker();
  }

  /**
   * ED 3 in the normal buffer: xterm is about to drop the lines above the
   * viewport and keep the screen. The line metadata follows, so the top row
   * becomes line 1.
   */
  private scrollbackErased() {
    // The cold store follows the same reset: everything above the viewport
    // is gone, so the history's line numbering starts over too.
    this.coldHistory.cleared();
    const dropped = this.term.buffer.active.length - this.term.rows;
    if (dropped <= 0) return;
    this.lineGutter.followTrimmedLines();
    this.lineGutter.dropLeadingLines(dropped);
    this.lineGutter.resetTrimMarker();
    this.lineGutter.firstLineNumber = 1;
    // The screen's own lines are renumbered from 1 here, so every recorded
    // line number means nothing now.
    this.cwdLines.reset();
    // `clear` on Linux erases the screen first, so its rows are among the
    // ones just dropped; the prompt that follows lands on line 1.
    if (this.lineGutter.lineCount === 0) this.lineGutter.setLineTimes([Date.now()]);
    this.lineGutter.invalidateGutter();
  }

  private clearBufferAndMetadata() {
    this.commands.dropAnchor();
    this.term.clear();
    // Not a write, so the find engine would go on reading the old lines.
    this.searchController.bufferChanged();
    this.resetLineMetadata();
  }

  private resetLineMetadata() {
    this.coldHistory.cleared();
    this.cwdLines.reset();
    this.lineGutter.setLineTimes([Date.now()]);
    this.lineGutter.firstLineNumber = 1;
    this.lineGutter.resetOutputTracking();
    this.lineGutter.resetTrimMarker();
    this.lineGutter.invalidateGutter();
    this.lineGutter.syncGutter();
  }

  setGutterMode(mode: GutterMode) {
    this.gutterMode = mode;
    this.lineGutter.applyGutterMode();
    this.lineGutter.invalidateGutter();
    this.lineGutter.syncGutter();
  }

  setSuggestions(enabled: boolean) {
    if (this.suggestionsOn === enabled) return;
    this.suggestionsOn = enabled;
    if (!enabled) {
      this.commands.dismissedInput = "";
      this.commands.hidePopup();
    }
  }

  setFontSize(fontSize: number) {
    // Compare against the value that would actually land (a pending hidden
    // change included): the last request wins, and 14→26→14 while hidden
    // must not leave 26 staged behind an early return.
    if ((this.pendingFont?.size ?? this.term.options.fontSize) === fontSize) return;
    if (!this.visible) {
      // The renderer re-measures the font from real pixels; a change made
      // while the pane is display:none left WebKit rendering the old font
      // after the show. Land it at the show boundary instead.
      this.pendingFont = { ...this.pendingFont, size: fontSize };
      return;
    }
    this.term.options.fontSize = fontSize;
    this.refreshFontMetrics();
  }

  /** The family is a full CSS stack; see `fontStack` in `fonts.ts`. */
  setFontFamily(fontFamily: string) {
    if ((this.pendingFont?.family ?? this.term.options.fontFamily) === fontFamily) return;
    if (!this.visible) {
      this.pendingFont = { ...this.pendingFont, family: fontFamily };
      return;
    }
    this.term.options.fontFamily = fontFamily;
    this.refreshFontMetrics();
  }

  /** The cursor's shape and whether it blinks, from Display Settings. */
  setCursor(style: CursorStyle, blink: boolean) {
    if (this.term.options.cursorStyle !== style) {
      this.term.options.cursorStyle = style;
    }
    if (this.term.options.cursorBlink !== blink) {
      this.term.options.cursorBlink = blink;
    }
  }

  /** The cell size follows the font. */
  private refreshFontMetrics() {
    this.lineGutter.cellHeight = 0;
    this.viewport.fit(true);
  }

  setTheme(theme: ThemeMode) {
    if (this.themeMode === theme) return;
    this.themeMode = theme;
    setSemanticColorTheme(theme);
    this.term.options.theme = XTERM_THEMES[theme];
    // The cells hold the previous palette's colors (and, between WindTerm and
    // serialX, the other engine's spans).
    this.semantic.recolorAll();
    this.searchController.refreshSearch();
    if (this.term.rows > 0) this.term.refresh(0, this.term.rows - 1);
  }

  setScrollback(scrollback: number) {
    if (this.scrollback === scrollback) return;
    this.scrollback = scrollback;
    this.term.options.scrollback = scrollback;
    // A smaller scrollback makes xterm drop the excess right away.
    this.lineGutter.resetTrimMarker();
    this.lineGutter.trimLineMetadata();
    this.lineGutter.syncGutter();
    this.searchController.bufferChanged();
  }

  scrollToLine(absoluteLine: number) {
    this.lineGutter.followTrimmedLines();
    this.term.scrollToLine(Math.max(0, absoluteLine - this.lineGutter.firstLineNumber));
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener("mousedown", this.clipboard.onSelectionMouseDown);
    window.removeEventListener("mouseup", this.clipboard.onSelectionMouseUp);
    this.host?.removeEventListener("mousemove", this.clipboard.onSelectionMouseMove, true);
    this.commands.dropAnchor();
    this.lineGutter.resetTrimMarker();
    this.commands.resetCommandTracking();
    if (this.transferNoticeTimer !== null) {
      window.clearTimeout(this.transferNoticeTimer);
      this.transferNoticeTimer = null;
    }
    this.imeComposition = null;
    this.viewport.dispose();
    this.hostResize?.disconnect();
    this.hostResize = null;
    this.gpu.dispose();
    this.zmodem.dispose();
    this.searchController.dispose();
    this.coldHistory.dispose();
    this.term.dispose();
    this.root = null;
    this.host = null;
    this.gutter = null;
    this.lineGutter.rowPool = [];
    this.semantic.stopBacklog();
  }

  // --- internals ------------------------------------------------------------

  private showTransferNotice(message: string, kind: TransferNoticeKind) {
    if (this.disposed) return;
    if (this.transferNoticeTimer !== null) {
      window.clearTimeout(this.transferNoticeTimer);
      this.transferNoticeTimer = null;
    }

    this.transferNoticeText.textContent = message;
    this.transferNotice.className = `transfer-notice is-${kind}`;
    // Only a transfer that is still running can be cancelled; a result line
    // never offers the control.
    this.transferCancel.hidden = kind !== "active";
    if (kind !== "active") {
      this.transferNoticeTimer = window.setTimeout(
        () => {
          this.transferNotice.classList.add("is-hidden");
          this.transferNoticeTimer = null;
        },
        kind === "error" ? 7000 : 4500,
      );
    }
  }

  /** Recolors and re-numbers the viewport once the current task is done. */
  private queueViewportSync() {
    if (this.viewportSyncQueued || this.disposed || !this.visible) return;
    this.viewportSyncQueued = true;
    queueMicrotask(() => {
      this.viewportSyncQueued = false;
      if (this.disposed || !this.visible) return;
      this.semantic.refreshSemanticColors();
      this.lineGutter.syncGutter();
    });
  }
}
