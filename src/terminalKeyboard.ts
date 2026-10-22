import { Terminal } from "@xterm/xterm";
import { IS_MAC } from "./platform";
import { matchAppShortcut } from "./shortcuts";
import { TerminalClipboard } from "./terminalClipboard";
import { TerminalCommands } from "./terminalCommands";
import { closeFindBox } from "./terminalSearch";
import { ALT_ARROW_SEQUENCES, isControlLetter } from "./terminalShared";

interface Context {
  readonly commands: Pick<
    TerminalCommands,
    | "popupIndex"
    | "candidates"
    | "dismissedInput"
    | "popupInput"
    | "forgetSuggestion"
    | "hidePopup"
    | "setPopupIndex"
    | "acceptSuggestion"
  >;
  readonly term: Terminal;
  readonly erase: string;
  readonly clipboard: Pick<TerminalClipboard, "copySelection" | "pasteFromClipboard">;
}

export class TerminalKeyboard {
  /**
   * xterm's key filter. True hands the key to xterm; false keeps it from
   * xterm, and unless it is cancelled here as well the window-level
   * shortcut handler still receives it.
   */
  filterKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();

    // IDE-style completion popup. While it is *passive* every key still
    // reaches the shell (so ↑ history, Tab completion and a remote shell's
    // own → autosuggest keep working); only ↓ (step into the list) and Esc
    // (dismiss) are taken. Once a row is selected the list owns ↑/↓ and
    // Enter/Tab accept — the user opted in by stepping into it.
    // Shift+Delete on a selected row forgets it, as in browser and IDE
    // completion lists; on macOS also Shift+⌫, since laptops have no
    // forward Delete key.
    if (
      this.context.commands.popupIndex >= 0 &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing &&
      (key === "delete" || (IS_MAC && key === "backspace"))
    ) {
      event.preventDefault();
      this.context.commands.forgetSuggestion(this.context.commands.popupIndex);
      return false;
    }
    if (
      this.context.commands.candidates.length > 0 &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      if (key === "escape") {
        event.preventDefault();
        this.context.commands.dismissedInput = this.context.commands.popupInput;
        this.context.commands.hidePopup();
        return false;
      }
      if (key === "arrowdown") {
        event.preventDefault();
        this.context.commands.setPopupIndex(
          this.context.commands.popupIndex >= this.context.commands.candidates.length - 1
            ? this.context.commands.candidates.length - 1
            : this.context.commands.popupIndex + 1,
        );
        return false;
      }
      if (this.context.commands.popupIndex >= 0) {
        if (key === "arrowup") {
          event.preventDefault();
          this.context.commands.setPopupIndex(this.context.commands.popupIndex - 1);
          return false;
        }
        if (key === "enter" || key === "tab") {
          event.preventDefault();
          this.context.commands.acceptSuggestion(this.context.commands.popupIndex);
          return false;
        }
      }
    }

    // Esc closes an open find box from here too, not only from its own input
    // (issue #95), as in VS Code's terminal. The shell does not get that
    // Esc, or readline would read the next key as Meta+key.
    if (
      key === "escape" &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      closeFindBox()
    ) {
      event.preventDefault();
      return false;
    }

    // Alt+arrow word jumps. xterm 5 rewrote Alt+←/→ into the readline
    // word-motion keys (ESC b / ESC f on macOS, Ctrl+arrow elsewhere) and
    // Alt+↑/↓ into Ctrl+↑/↓ off macOS; xterm 6 dropped that (#5346) and
    // sends the plain Alt-modified sequences, which zsh and bash leave
    // unbound. Kept here so the keys behave as they did in 0.6.x.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
      const sequence = ALT_ARROW_SEQUENCES[key];
      if (sequence) {
        event.preventDefault();
        this.context.term.input(sequence, true);
        return false;
      }
    }

    // Backspace sends ^H where the profile asks for it (#89). xterm has no
    // option for this, and sends ^? for Backspace and ^H for Ctrl+Backspace,
    // so in ^H mode the two trade places, leaving ^? one chord away. Alt
    // keeps its ESC prefix, as xterm gives Alt+Backspace.
    if (
      this.context.erase === "\x08" &&
      key === "backspace" &&
      !event.metaKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      this.context.term.input(
        (event.altKey ? "\x1b" : "") + (event.ctrlKey ? "\x7f" : "\x08"),
        true,
      );
      return false;
    }

    // The shortcut table, copy / paste / select all included (#47). Those
    // three are the terminal's own and run right here; every other match
    // is left unhandled — not cancelled — so the window-level handler
    // receives it instead of xterm turning it into input. Plain
    // Ctrl+letter and Alt+letter are never matched unless the user bound
    // them: they are the shell's control characters and readline's Meta
    // layer.
    const shortcut = matchAppShortcut(event);
    if (shortcut) {
      switch (shortcut.kind) {
        case "copy":
          // A copy key that is plain Ctrl+letter is a shell key as well
          // (Ctrl+C interrupts), so with nothing selected it goes on to the
          // shell, as in Windows Terminal. Any other chord is consumed even
          // then: Ctrl+Shift+C would otherwise arrive as a stray ^C.
          if (!this.context.term.hasSelection() && isControlLetter(event)) return true;
          event.preventDefault();
          this.context.clipboard.copySelection();
          return false;
        case "paste":
          event.preventDefault();
          this.context.clipboard.pasteFromClipboard();
          return false;
        case "selectAll":
          event.preventDefault();
          this.context.term.selectAll();
          return false;
        default:
          return false;
      }
    }

    // WebKit answers plain ⌘C / ⌘V itself (its copy and paste editing
    // commands fire on xterm's textarea) and xterm maps ⌘A to select-all,
    // so once the user has moved those commands to other keys these have
    // to be swallowed, or the old bindings would go on working beside the
    // new ones. ⌘ never reaches the shell, so nothing is lost.
    if (
      IS_MAC &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      (key === "c" || key === "v" || key === "a")
    ) {
      event.preventDefault();
      return false;
    }
    return true;
  }
  constructor(private readonly context: Context) {}
}
