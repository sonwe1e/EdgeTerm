import { Terminal } from "@xterm/xterm";
import { readClipboardText, writeClipboardText } from "./api";
import { type ProgramClipboardMode } from "./osc52";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { needsPasteWarning } from "./terminalPaste";
import { RightClickAction } from "./terminalShared";
import { errorMessage, type TransferNoticeKind } from "./terminalTransfer";

interface Context {
  readonly host: HTMLElement | null;
  readonly disposed: boolean;
  readonly term: Terminal;
  readonly showTransferNotice: (message: string, kind: TransferNoticeKind) => void;
}

export class TerminalClipboard {
  /** Edit → Warn Before Multi-line Paste; see `paste`. */
  private pasteWarning = true;

  /** Edit → Copy on Select; see `onSelectionMouseUp`. */
  private copyOnSelect = false;

  /** A left button is down on this terminal, so a selection is being made. */
  private selecting = false;

  /** The selection changed since that button went down. */
  selectionChanged = false;

  private confirmPaste: ((text: string) => void) | null = null;

  /** Edit → Programs Can Set Clipboard; see `programClipboardWrite`. */
  private programClipboard: ProgramClipboardMode = "ask";

  /** The user allowed this session's OSC 52 writes when asked. */
  private programClipboardAllowed = false;

  private confirmClipboardWrite: ((text: string) => void) | null = null;

  onSelectionMouseDown = (event: MouseEvent) => {
    // Only the left button makes a selection to copy. The right one selects
    // the word under the pointer in menu mode, and putting that on the
    // clipboard for merely opening the menu is not what was asked for.
    const target = event.target;
    this.selecting =
      event.button === 0 &&
      !!this.context.host &&
      target instanceof Node &&
      this.context.host.contains(target);
    this.selectionChanged = false;
  };

  /**
   * Copy on select, the X11 / PuTTY / Xshell habit that Windows Terminal
   * calls `copyOnSelect`: a selection made with the mouse is on the
   * clipboard the moment the button comes up, with no Copy in between.
   *
   * The copy waits for the button rather than running from
   * `onSelectionChange`, for two reasons: a selection is only finished once
   * the drag is, and WebKit lets a page write the clipboard only from inside
   * a user gesture, which a mid-drag selection event is not. A selection the
   * mouse had no part in (Select All from a key or a menu) is left alone —
   * it would replace the clipboard with the whole scrollback behind the
   * user's back.
   */
  onSelectionMouseUp = () => {
    const made = this.selecting && this.selectionChanged;
    this.selecting = false;
    this.selectionChanged = false;
    if (!made || !this.copyOnSelect || this.context.disposed) return;
    this.copySelection();
  };

  hasSelection(): boolean {
    return this.context.term.hasSelection();
  }

  /**
   * Copies the selection to the clipboard; false when there is none. A write
   * that fails is reported in the pane rather than swallowed: with Copy on
   * Select there is no other sign that nothing was copied.
   */
  copySelection(): boolean {
    if (!this.context.term.hasSelection()) return false;
    this.writeClipboard(this.context.term.getSelection());
    return true;
  }

  selectAll() {
    this.context.term.selectAll();
  }

  clearSelection() {
    this.context.term.clearSelection();
  }

  /**
   * `rightClickSelectsWord` follows the right-click mode: in "menu" mode a
   * right click selects the word under the pointer so the menu's Copy has
   * something to copy (VS Code); in "copyPaste" mode it must stay off, or a
   * right click meant to paste would select a word and copy it instead.
   */
  setRightClickAction(action: RightClickAction) {
    this.context.term.options.rightClickSelectsWord = action === "menu";
  }

  /**
   * Pastes the clipboard as typed input — from the paste key, the Edit menu,
   * the terminal's own menu, a right click in copy-or-paste mode and the
   * middle button, so everything that pastes passes the check below. A read
   * that fails is reported in the pane rather than swallowed, which is how
   * #45 looked: a paste that did nothing at all.
   */
  pasteFromClipboard() {
    void this.readClipboard().then(
      (text) => {
        if (text) this.paste(text);
      },
      (error: unknown) => {
        this.context.showTransferNotice(`Paste failed: ${errorMessage(error)}`, "error");
      },
    );
  }

  /**
   * Hands text to the terminal as if it were typed. xterm applies bracketed
   * paste; a locked terminal keeps it out of `onData` (see `setLocked`).
   *
   * A paste the shell would run as several commands is confirmed first
   * (issue #63): the lines after the first are executed the moment they
   * arrive, so a stray clipboard is a handful of commands on a production
   * host before anything can be read. Confirming is the terminal's
   * convention — Windows Terminal, iTerm2 and Xshell all do it — and
   * `pasteWarning` turns it off. `confirmPaste` shows the dialog and calls
   * back here; without a confirmer (a test, a pane still wiring up) the text
   * goes through, since refusing to paste would be worse than pasting.
   */
  paste(text: string) {
    if (this.pasteWarning && this.confirmPaste && needsPasteWarning(text)) {
      this.confirmPaste(text);
      return;
    }
    this.writePaste(text);
  }

  /**
   * Pastes without asking — what the confirmation dialog calls once the user
   * has said yes, and the only path that may skip the check.
   */
  writePaste(text: string) {
    this.context.term.paste(text);
  }

  /** Edit → Warn Before Multi-line Paste. */
  setPasteWarning(enabled: boolean) {
    this.pasteWarning = enabled;
  }

  /** Edit → Copy on Select; see `onSelectionMouseUp`. */
  setCopyOnSelect(enabled: boolean) {
    this.copyOnSelect = enabled;
  }

  /** Edit → Programs Can Set Clipboard. */
  setProgramClipboard(mode: ProgramClipboardMode) {
    this.programClipboard = mode;
  }

  /**
   * Where an OSC 52 write that needs the user's yes goes; the dialog calls
   * `allowProgramClipboard` once it is given.
   */
  onConfirmClipboardWrite(confirm: (text: string) => void) {
    this.confirmClipboardWrite = confirm;
  }

  /**
   * The user said yes to this session's program setting the clipboard:
   * writes the text that asked and lets later writes through without asking
   * again, since a program that copies once (an agent, tmux) copies on every
   * selection and one prompt each time would be unusable.
   */
  allowProgramClipboard(text: string) {
    this.programClipboardAllowed = true;
    this.writeClipboard(text);
  }

  /**
   * A program's OSC 52 write. In "ask" mode the first one of the session
   * waits for the user; without a confirmer (a test, a pane still wiring up)
   * it is dropped, since the clipboard is the user's and a program has no
   * claim on it that has not been granted.
   */
  programClipboardWrite(text: string) {
    if (this.context.disposed || this.programClipboard === "deny") return;
    if (this.programClipboard === "allow" || this.programClipboardAllowed) {
      this.writeClipboard(text);
    } else {
      this.confirmClipboardWrite?.(text);
    }
  }

  /**
   * Puts text on the clipboard. On macOS and Windows the process does it
   * (`write_clipboard_text`): a program's OSC 52 write arrives with its
   * output, outside any user gesture, and WKWebView does not count the mouse
   * up that ends a selection drag as one either, so Copy on Select copied
   * nothing on macOS (issue #63). WebKitGTK lets the page write it (see
   * `enable_clipboard_access`).
   */
  private writeClipboard(text: string) {
    const write =
      IS_MAC || IS_WINDOWS ? writeClipboardText(text) : navigator.clipboard.writeText(text);
    void write.catch((error: unknown) => {
      this.context.showTransferNotice(`Copy failed: ${errorMessage(error)}`, "error");
    });
  }

  /**
   * Where a paste that needs confirming goes; the dialog calls `paste` back
   * with the same text once the user has said yes.
   */
  onConfirmPaste(confirm: (text: string) => void) {
    this.confirmPaste = confirm;
  }

  /**
   * The clipboard's text. On macOS the process reads it
   * (`read_clipboard_text`): WebKit lets a page read the pasteboard only from
   * inside its own paste command (⌘V, Edit → Paste on the system menu) and
   * answers any other gesture with a "Paste" confirmation menu the user has
   * to click, which a rebindable paste key cannot live with. Elsewhere the
   * page reads it, which WebView2 gates behind the clipboard-read permission
   * (granted through `enable_clipboard_access` in lib.rs). A profile that
   * refused the prompt before the app granted it keeps refusing, and the
   * prompt is not raised again, so on Windows the process reads it as well
   * when the page cannot.
   */
  private async readClipboard(): Promise<string> {
    if (IS_MAC) return readClipboardText();
    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      if (!IS_WINDOWS) throw error;
      return readClipboardText();
    }
  }

  /**
   * True while a program in the terminal (vim, tmux, htop…) has enabled
   * mouse reporting, in which case clicks belong to it rather than to the
   * app's copy / paste handling.
   */
  isMouseTracked(): boolean {
    return this.context.term.modes.mouseTrackingMode !== "none";
  }
  constructor(private readonly context: Context) {}
}
