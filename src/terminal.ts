import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { TerminalClipboard } from "./terminalClipboard";
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
  openTerminalWebLink,
  parseOsc1337,
  parseOsc7,
  parseOsc9,
} from "./terminalShared";
import { TerminalViewport } from "./terminalViewport";
export { parseOsc1337, parseOsc7, parseOsc9 } from "./terminalShared";
export type { CursorStyle, GutterMode, ReportedCwd, RightClickAction } from "./terminalShared";

import { createOutputDecoder } from "./encodings";
import { MONO_FONT_FAMILY } from "./fonts";
import { t as translate } from "./i18n";
import { patchImeInput } from "./imePatch";
import { parseOsc52, type ProgramClipboardMode } from "./osc52";
import { setSemanticColorTheme } from "./semanticColors";
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
  private readonly keyboard: TerminalKeyboard;

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
    return this.viewport.fit(immediate);
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
      // Kept in step with the right-click setting by setRightClickAction:
      // only the menu mode wants the word under the pointer selected first.
      rightClickSelectsWord: true,
    });
    this.keyboard = new TerminalKeyboard({
      get commands() {
        return owner.commands;
      },

      get term() {
        return owner.term;
      },

      get erase() {
        return owner.erase;
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

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon(openTerminalWebLink));
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";

    // A file transfer owns the byte stream while it is active. Forwarding
    // keystrokes or paste data in the middle of a binary frame corrupts it.
    this.term.onData((data) => this.handleData(data));
    // Shells with OSC 7 / 1337 / 9;9 integration announce their working
    // directory at every prompt. Only the latest report is kept: it answers
    // "Reveal Working Directory in Filer" exactly, nested shells and sudo
    // included, wherever the OS or the server cannot be asked.
    const report = (parse: (data: string) => ReportedCwd | null) => (data: string) => {
      const cwd = parse(data);
      if (cwd) {
        this.reported = cwd;
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
    this.viewport.observeDisplayChanges();
    // IME text takes the exactly-once path in imePatch.ts. It hooks the
    // composition helper xterm creates in open(), so it goes right after.
    patchImeInput(this.term);
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

  /**
   * Tells the terminal whether its pane is on screen. WebGL is loaded on
   * showing and kept while hidden, so switching back to a recent tab costs
   * nothing; the least recently shown terminals lose theirs past
   * WEBGL_MAX_TERMINALS.
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
      this.lineGutter.syncGutter();
      this.semantic.scheduleBacklog();
    } else {
      this.viewport.suspend();
      this.semantic.stopBacklog();
    }
  }

  write(data: Uint8Array, consumed?: () => void) {
    if (this.disposed) {
      consumed?.();
      return;
    }
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
    if (consumed) this.term.write("", consumed);
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
    this.locked = locked;
    this.term.write(locked ? "\x1b[?25l" : "\x1b[?25h");
    if (locked) {
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
    this.commands.trackInput(data);
    this.callbacks.onData(data);
  }

  /**
   * The working directory the shell last announced through OSC 7 / 1337 /
   * 9;9, or null when it never has (or the session ended since).
   */
  get reportedCwd(): ReportedCwd | null {
    return this.reported;
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
    const dropped = this.term.buffer.active.length - this.term.rows;
    if (dropped <= 0) return;
    this.lineGutter.followTrimmedLines();
    this.lineGutter.dropLeadingLines(dropped);
    this.lineGutter.resetTrimMarker();
    this.lineGutter.firstLineNumber = 1;
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
    this.commands.dropAnchor();
    this.lineGutter.resetTrimMarker();
    this.commands.resetCommandTracking();
    if (this.transferNoticeTimer !== null) {
      window.clearTimeout(this.transferNoticeTimer);
      this.transferNoticeTimer = null;
    }
    this.viewport.dispose();
    this.hostResize?.disconnect();
    this.hostResize = null;
    this.gpu.dispose();
    this.zmodem.dispose();
    this.searchController.dispose();
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
