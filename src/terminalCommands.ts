import closeIcon from "@vscode/codicons/src/icons/close.svg?raw";
import { Terminal, type IBufferLine, type IMarker } from "@xterm/xterm";
import { isAiSessionCommand } from "./aiTools";
import type { CommandSuggestion } from "./history";
import { IS_MAC } from "./platform";
import { isShellPrompt, shellPromptEnd } from "./semanticColors";
import { TerminalLineGutter } from "./terminalLineGutter";
import { AI_QUIET_MS, Callbacks, InputAnchor, TERMINAL_REPORT } from "./terminalShared";

interface Context {
  readonly disposed: boolean;
  readonly locked: boolean;
  readonly isTransferActive: () => boolean;
  readonly term: Terminal;
  readonly callbacks: Callbacks;
  readonly suggestionsOn: boolean;
  readonly host: HTMLElement | null;
  readonly lineGutter: Pick<TerminalLineGutter, "cellHeight" | "measureCell">;
  readonly erase: string;
}

export class TerminalCommands {
  inputAnchor: InputAnchor | null = null;

  /** Marker and prompt signature for detecting when the submitted command returns. */
  private commandMarker: IMarker | null = null;

  private commandPrompt = "";

  private commandPromptRecognized = false;

  commandOutputAdvanced = false;

  commandRunning = false;

  /** Callers waiting for the running command to return; see `waitForCommand`. */
  private commandWaiters: (() => void)[] = [];

  /** Set while an agentic CLI (see `aiTools.ts`) owns the terminal. */
  private aiSession = false;

  /** Open from the user's input until the assistant goes quiet again. */
  aiTurn = false;

  aiOutputAt = 0;

  private aiQuietTimer: number | null = null;

  popup: HTMLElement;

  /** Rows currently displayed; [] while the popup is hidden. */
  candidates: CommandSuggestion[] = [];

  /** Selected row, or -1 while the popup is passive (keys pass through). */
  popupIndex = -1;

  /** The input the current candidates were computed for. */
  popupInput = "";

  /** Input the user dismissed the popup for (Esc / accept); "" = none. */
  dismissedInput = "";

  private popupSyncScheduled = false;

  /**
   * Records a command sent outside xterm's keyboard path (the Sender panel).
   * Call immediately before writing it so the current prompt can be used as
   * the completion signature.
   */
  noteCommandSent(command?: string) {
    // Text sent into an agentic CLI already holding the terminal is a turn
    // for it, not a command line the shell will answer with a prompt.
    if (this.aiSession) {
      this.noteAiInput();
      return false;
    }
    return this.beginCommand(undefined, command);
  }

  /**
   * Resolves once the command in progress has returned to its prompt — the
   * Sender waits for that before the next line of a script — or after
   * `timeoutMs`, and at once while nothing is running. The end of the
   * session ends the wait as well, since locking resets the tracking.
   */
  waitForCommand(timeoutMs: number): Promise<void> {
    if (!this.commandRunning) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(() => {
        this.commandWaiters = this.commandWaiters.filter((w) => w !== done);
        resolve();
      }, timeoutMs);
      this.commandWaiters.push(done);
    });
  }

  /** Rolls back `noteCommandSent` when the IPC write itself was rejected. */
  cancelCommandSent() {
    if (!this.commandRunning) return;
    this.resetCommandTracking();
    this.emitCommandState("idle");
  }

  // --- command history & inline suggestions --------------------------------

  /**
   * Begins (or replaces) the command currently represented by this tab.
   * `sent` carries the command line when it was not typed here (the Sender
   * panel), where the buffer only holds the prompt it is about to follow.
   */
  beginCommand(anchor?: InputAnchor, sent?: string) {
    if (
      this.context.disposed ||
      this.context.locked ||
      this.commandRunning ||
      this.context.isTransferActive() ||
      this.context.term.buffer.active.type !== "normal"
    ) {
      return false;
    }

    const buf = this.context.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    const anchored = anchor !== undefined && this.anchorOnCursorLine(anchor);

    let prompt: string;
    if (anchor && !anchored) {
      // The anchor no longer marks where the prompt ends, so read the
      // boundary off the submitted line itself. Without a recognizable
      // prompt there is no signature to wait for, and claiming a command
      // that can never complete is worse than tracking none.
      const text = this.cursorLine()?.text ?? "";
      const end = shellPromptEnd(text);
      if (end < 0) return false;
      prompt = text.slice(0, end);
    } else {
      const row = anchored ? anchor.marker.line : cursorRow;
      const col = anchored ? anchor.col : buf.cursorX;
      prompt = buf.getLine(row)?.translateToString(false, 0, col) ?? "";
    }

    this.commandMarker?.dispose();
    this.commandMarker = this.context.term.registerMarker(0);
    this.commandPrompt = prompt;
    // Appending a space lets a compact bare prompt such as `$` satisfy the
    // same look-ahead rule as `$ command` in semantic coloring.
    this.commandPromptRecognized = isShellPrompt(`${prompt} `);
    this.commandOutputAdvanced = false;
    this.commandRunning = true;
    this.aiSession = isAiSessionCommand(sent ?? this.submittedCommand(prompt));
    // An agentic CLI runs until the user quits it, so reporting its whole
    // session as one running command would say nothing. The tab stays quiet
    // until the assistant itself is working.
    this.emitCommandState(this.aiSession ? "idle" : "running");
    return true;
  }

  /**
   * The command just submitted, read back from the line it was typed on.
   * The prompt is cut off by its recognized end where there is one, so a
   * shell-integration start (OSC 133 C, which arrives with the whole line
   * already echoed) reads the same as a typed one.
   */
  private submittedCommand(prompt: string): string {
    const text = this.cursorLine()?.text ?? "";
    const end = shellPromptEnd(text);
    return text.slice(end >= 0 ? end : prompt.length).trim();
  }

  /**
   * True while the anchor still sits on the line the cursor is editing, the
   * only case in which it says anything about that line. Keystrokes a
   * foreground program consumed leave one behind pointing into the screen
   * that program painted — `q` to leave Linux top, which runs in the normal
   * buffer and never sees an Enter — and a scrollback trim retires its
   * marker outright. A prompt read from there is never printed again, so the
   * command would stay "running" for the rest of the session, and so would
   * every command after it, because a running one blocks the next.
   */
  private anchorOnCursorLine(anchor: InputAnchor): boolean {
    if (anchor.marker.isDisposed) return false;
    const buf = this.context.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    const first = this.cursorLine()?.first ?? cursorRow;
    return anchor.marker.line >= first && anchor.marker.line <= cursorRow;
  }

  /** Current logical line up to the cursor, including soft-wrapped rows. */
  private cursorLine(): { first: number; text: string } | null {
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal") return null;
    const cursor = buf.baseY + buf.cursorY;
    let first = cursor;
    while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;

    let text = "";
    for (let row = first; row <= cursor; row += 1) {
      const line = buf.getLine(row);
      if (!line) return null;
      text += line.translateToString(false, 0, row === cursor ? buf.cursorX : undefined);
    }
    return { first, text };
  }

  /** Completes once a fresh prompt appears below the submitted command. */
  detectReturnedPrompt() {
    if (!this.commandRunning) return;
    const current = this.cursorLine();
    if (!current) return;

    const markerLine = this.commandMarker?.line ?? -1;
    if (markerLine >= 0) {
      if (current.first <= markerLine) return;
      this.commandOutputAdvanced = true;
    } else if (!this.commandOutputAdvanced) {
      return;
    }

    const samePrompt =
      this.commandPrompt.trim().length > 0 && current.text.startsWith(this.commandPrompt);
    const knownPrompt = this.commandPromptRecognized && isShellPrompt(`${current.text} `);
    if (samePrompt || knownPrompt) this.finishCommand();
  }

  finishCommand() {
    if (!this.commandRunning) return;
    // Keystrokes sent while the command owned the terminal (`q` to leave
    // top, a pager's keys, an answer to a question) belonged to it, not to
    // the next command line. The anchor they left points at a row the
    // program painted, which history would then record as a command.
    this.dropAnchor();
    const kind = this.aiSession ? "ai" : "command";
    this.resetCommandTracking();
    if (!this.context.disposed) this.context.callbacks.onCommandState("complete", kind);
  }

  resetCommandTracking() {
    this.commandMarker?.dispose();
    this.commandMarker = null;
    this.commandPrompt = "";
    this.commandPromptRecognized = false;
    this.commandOutputAdvanced = false;
    this.commandRunning = false;
    this.endAiSession();
    const waiters = this.commandWaiters;
    this.commandWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private emitCommandState(state: "idle" | "running" | "complete") {
    if (!this.context.disposed) {
      this.context.callbacks.onCommandState(state, this.aiSession ? "ai" : "command");
    }
  }

  /**
   * A keystroke inside an agentic CLI opens a turn, and the tool's own
   * repainting keeps it open: every one of them animates a spinner and an
   * elapsed time while it works, and goes quiet the moment it wants the user
   * back — quiet is the end of the turn. Output alone never opens one, or an
   * idle tool's occasional repaint would announce work that never happened.
   */
  private noteAiInput() {
    this.aiOutputAt = Date.now();
    if (!this.aiTurn) {
      this.aiTurn = true;
      this.emitCommandState("running");
    }
    this.armAiQuiet(AI_QUIET_MS);
  }

  private armAiQuiet(delay: number) {
    if (this.aiQuietTimer !== null) return;
    this.aiQuietTimer = window.setTimeout(() => {
      this.aiQuietTimer = null;
      if (this.context.disposed || !this.aiTurn) return;
      const quiet = Date.now() - this.aiOutputAt;
      if (quiet < AI_QUIET_MS) {
        this.armAiQuiet(AI_QUIET_MS - quiet);
        return;
      }
      this.aiTurn = false;
      this.emitCommandState("complete");
    }, delay);
  }

  private endAiSession() {
    if (this.aiQuietTimer !== null) {
      window.clearTimeout(this.aiQuietTimer);
      this.aiQuietTimer = null;
    }
    this.aiSession = false;
    this.aiTurn = false;
  }

  /**
   * Follows the user's keystrokes to delimit the command being composed.
   * Keystroke echo comes back from the shell, so the buffer — not the raw
   * input — is the source of truth for the command text; this only decides
   * *where* that text starts and *when* it was submitted.
   */
  trackInput(data: string) {
    // Terminal reports come through here as well; nothing below is about
    // them (see `TERMINAL_REPORT`).
    if (TERMINAL_REPORT.test(data)) return;
    // Before the alternate-screen check below: an agentic CLI may hold
    // either buffer, and its turns are driven by these keystrokes.
    if (this.aiSession) this.noteAiInput();
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal") {
      this.dropAnchor();
      return;
    }
    if (data === "\r") {
      // The anchor exists as soon as the user starts editing the prompt. It
      // is a better signal than the buffer text here because the last remote
      // echo may still be in flight when Enter arrives.
      if (this.commandRunning) {
        // Input requested by the foreground command (sudo password, a REPL,
        // an installer question) is not another shell command and must not
        // replace the prompt signature we are waiting to see again.
        this.dropAnchor();
      } else {
        if (this.inputAnchor) this.beginCommand(this.inputAnchor);
        this.captureCommand();
      }
    } else if (data === "\x03") {
      // Ctrl+C abandons the line.
      this.dropAnchor();
    } else if (data.includes("\r") || data.includes("\n")) {
      // A multi-line paste executed commands we did not watch being typed;
      // the anchor no longer describes anything real.
      if (!this.commandRunning && (/[^\s\r\n]/.test(data) || this.inputAnchor)) {
        this.beginCommand();
      }
      this.dropAnchor();
    } else if (!this.inputAnchor) {
      const marker = this.context.term.registerMarker(0);
      if (marker) this.inputAnchor = { marker, col: buf.cursorX };
    }
    this.schedulePopupSync();
  }

  /**
   * Reads the command submitted with Enter. The buffer is read again after a
   * short delay so echoes still in flight from the remote (the last
   * keystrokes of a fast typist, or a shell erasing its own autosuggestion)
   * have settled; the immediate snapshot is the fallback in case the line is
   * gone by then (e.g. a `clear` in the executed command's output).
   */
  private captureCommand() {
    const anchor = this.inputAnchor;
    this.inputAnchor = null;
    this.dismissedInput = "";
    this.hidePopup();
    if (!anchor) return;
    if (!this.anchorOnCursorLine(anchor)) {
      // Not the line being submitted: whatever it points at is output, not
      // something the user typed here.
      anchor.marker.dispose();
      return;
    }

    const snapshot = this.readInput(anchor);
    window.setTimeout(() => {
      const settled = this.context.disposed ? null : this.readInput(anchor);
      anchor.marker.dispose();
      const command = (settled ?? snapshot ?? "")
        // A zsh-style right prompt shares the input row, separated from the
        // command by a run of padding spaces; cut it off. Three-plus literal
        // spaces inside a real command line are vanishingly rare.
        .replace(/ {3,}\S.*$/, "")
        .trimEnd();
      // A leading space opts out of history, mirroring the shells'
      // `ignorespace` convention. Length guards against captured output.
      if (!command || command.startsWith(" ") || command.length > 500) return;
      if (!this.context.disposed && this.context.suggestionsOn)
        this.context.callbacks.onCommand(command);
    }, 150);
  }

  /**
   * The typed text: anchor column to the end of the (soft-wrapped) line, or
   * to `end` (a buffer position, normally the cursor) when given. The popup
   * passes the cursor so trailing spaces the user typed survive (right-
   * trimming would corrupt the accepted remainder), a zsh-style right prompt
   * on the same row is never read as input, and a remote shell's own inline
   * autosuggestion after the cursor is ignored. Returns null when `end` does
   * not lie on the anchor's logical line.
   */
  private readInput(anchor: InputAnchor, end?: { row: number; col: number }): string | null {
    if (anchor.marker.isDisposed) return null;
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal") return null;
    let row = anchor.marker.line;
    const first = buf.getLine(row);
    if (!first) return null;

    const lines: { line: IBufferLine; start: number }[] = [{ line: first, start: anchor.col }];
    let next = buf.getLine(row + 1);
    while (next?.isWrapped && lines.length <= 10) {
      lines.push({ line: next, start: 0 });
      row += 1;
      next = buf.getLine(row + 1);
    }

    const lastIndex = end ? end.row - anchor.marker.line : lines.length - 1;
    if (lastIndex < 0 || lastIndex >= lines.length) return null;

    let text = "";
    for (let i = 0; i <= lastIndex; i += 1) {
      const { line, start } = lines[i];
      if (i < lastIndex) {
        // A wrapped row is filled edge to edge; every cell is content.
        text += line.translateToString(false, start);
      } else if (end) {
        text += line.translateToString(false, start, Math.max(end.col, start));
      } else {
        text += line.translateToString(true, start);
      }
    }
    return text;
  }

  schedulePopupSync() {
    if (this.popupSyncScheduled || this.context.disposed) return;
    this.popupSyncScheduled = true;
    requestAnimationFrame(() => {
      this.popupSyncScheduled = false;
      if (!this.context.disposed) this.syncPopup();
    });
  }

  /**
   * Shows history matches for the typed input as a floating completion list
   * anchored to the cursor, IDE-style. The input is read up to the cursor
   * only, so a remote shell's own inline autosuggestion (fish,
   * zsh-autosuggestions) after the cursor never feeds back into ours.
   */
  private syncPopup() {
    const anchor = this.inputAnchor;
    if (!this.context.suggestionsOn || !anchor || !this.context.host) {
      this.hidePopup();
      return;
    }
    const buf = this.context.term.buffer.active;
    if (buf.type !== "normal" || anchor.marker.isDisposed) {
      this.hidePopup();
      return;
    }

    const cursorRow = buf.baseY + buf.cursorY;
    const input = this.readInput(anchor, {
      row: cursorRow,
      col: buf.cursorX,
    });
    if (!input || input === this.dismissedInput) {
      this.hidePopup();
      return;
    }

    const candidates = this.context.callbacks.suggest(input);
    if (candidates.length === 0) {
      this.hidePopup();
      return;
    }

    const viewRow = cursorRow - buf.viewportY;
    const screen = this.context.host.querySelector<HTMLElement>(".xterm-screen");
    if (
      viewRow < 0 ||
      viewRow >= this.context.term.rows ||
      !screen ||
      this.context.term.cols === 0
    ) {
      this.hidePopup();
      return;
    }
    if (this.context.lineGutter.cellHeight <= 0) this.context.lineGutter.measureCell();
    if (this.context.lineGutter.cellHeight <= 0) {
      this.hidePopup();
      return;
    }

    const inputChanged = input !== this.popupInput;
    this.popupInput = input;
    this.candidates = candidates;
    // New input returns the popup to passive so stray navigation state never
    // survives a keystroke; stepping into the list is always deliberate.
    if (inputChanged) this.popupIndex = -1;
    else if (this.popupIndex >= candidates.length) {
      this.popupIndex = candidates.length - 1;
    }
    this.renderPopup();

    // Horizontally at the input's start (IDE convention), vertically under
    // the cursor row, flipped above when there is no room below.
    const screenRect = screen.getBoundingClientRect();
    const hostRect = this.context.host.getBoundingClientRect();
    const cellWidth = screenRect.width / this.context.term.cols;
    const anchorCol = cursorRow === anchor.marker.line ? anchor.col : 0;
    const screenLeft = screenRect.left - hostRect.left;
    const screenTop = screenRect.top - hostRect.top;

    this.popup.classList.remove("is-hidden");
    this.popup.style.maxWidth = `${Math.max(120, hostRect.width - 12)}px`;
    const width = this.popup.offsetWidth;
    const height = this.popup.offsetHeight;
    const left = Math.max(
      0,
      Math.min(screenLeft + anchorCol * cellWidth, hostRect.width - width - 6),
    );
    let top = screenTop + (viewRow + 1) * this.context.lineGutter.cellHeight + 2;
    if (top + height > hostRect.height) {
      const above = screenTop + viewRow * this.context.lineGutter.cellHeight - height - 2;
      if (above >= 0) top = above;
    }
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  private renderPopup() {
    this.popup.replaceChildren();
    this.candidates.forEach((candidate, index) => {
      const row = document.createElement("div");
      row.className = `term-suggest-item${index === this.popupIndex ? " is-selected" : ""}`;
      row.setAttribute("role", "option");

      const { command, matchStart } = candidate;
      const matchEnd = matchStart + this.popupInput.length;
      const pre = document.createElement("span");
      pre.textContent = command.slice(0, matchStart);
      const match = document.createElement("span");
      match.className = "term-suggest-match";
      match.textContent = command.slice(matchStart, matchEnd);
      const post = document.createElement("span");
      post.textContent = command.slice(matchEnd);
      const text = document.createElement("span");
      text.className = "term-suggest-text";
      text.append(pre, match, post);

      const remove = document.createElement("span");
      remove.className = "term-suggest-remove";
      remove.title = `Remove from History (${IS_MAC ? "⇧⌫" : "Shift+Delete"})`;
      remove.innerHTML = closeIcon;
      remove.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.forgetSuggestion(index);
      });
      row.append(text, remove);

      row.addEventListener("mousedown", (event) => {
        // preventDefault keeps focus in the terminal.
        event.preventDefault();
        this.acceptSuggestion(index);
      });
      this.popup.appendChild(row);
    });
  }

  setPopupIndex(index: number) {
    this.popupIndex = Math.max(-1, Math.min(index, this.candidates.length - 1));
    const rows = this.popup.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle("is-selected", i === this.popupIndex);
    }
  }

  acceptSuggestion(index: number) {
    const candidate = this.candidates[index] ?? this.candidates[0];
    if (!candidate) return;
    const input = this.popupInput;
    // A prefix match completes in place. Any other match erases the typed
    // input first — one backspace per code point, so the shell edits its own
    // line — then sends the full command.
    const data = candidate.command.startsWith(input)
      ? candidate.command.slice(input.length)
      : this.context.erase.repeat([...input].length) + candidate.command;
    this.dismissedInput = candidate.command;
    this.hidePopup();
    if (data && !this.context.locked && !this.context.isTransferActive()) {
      this.context.callbacks.onData(data);
    }
  }

  /** Drops a row from the history and redraws the list for the same input. */
  forgetSuggestion(index: number) {
    const candidate = this.candidates[index];
    if (!candidate) return;
    this.context.callbacks.forgetSuggestion(candidate.command);
    this.syncPopup();
  }

  hidePopup() {
    if (this.candidates.length === 0) return;
    this.candidates = [];
    this.popupIndex = -1;
    this.popup.replaceChildren();
    this.popup.classList.add("is-hidden");
  }

  dropAnchor() {
    this.inputAnchor?.marker.dispose();
    this.inputAnchor = null;
    this.dismissedInput = "";
    this.hidePopup();
  }
  constructor(private readonly context: Context) {
    this.popup = document.createElement("div");
    this.popup.className = "term-suggest is-hidden";
    this.popup.setAttribute("role", "listbox");
  }
}
