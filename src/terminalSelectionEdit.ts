import { Terminal, type IBuffer, type IBufferLine } from "@xterm/xterm";
import { shellPromptEnd } from "./semanticColors";

/**
 * Direct editing of a mouse selection on the shell's input line.
 *
 * The terminal never edits its own buffer copy of the line — the shell
 * (readline, zle, PSReadLine) owns it, and over SSH the local buffer is only a
 * mirror of the remote echo. An edit is therefore sent as the key sequences the
 * shell itself would answer to a keyboard: the cursor walks left with CSI D,
 * one *character* per press (exactly how readline and friends treat the arrow
 * keys), forward-delete removes the selection with CSI 3~, and a final walk
 * right with CSI C puts the shell cursor back where it began. This mirrors
 * xterm's own altClickMovesCursor, which walks the shell cursor with arrow-key
 * sequences instead of teleporting the local cell.
 *
 * Walking back matters after the edit, not before it: forward-delete leaves the
 * shell's cursor at the selection's start, so without the walk back the line's
 * remaining text is to the *right* of the cursor. The next selection over that
 * text then reaches past the cursor and is refused, and 1.6.1 deleted a single
 * character at the cursor instead — the reported defect. The walk right only
 * crosses cells that were to the left of the original cursor, so it never
 * presses Right at the end of the shell's buffer where zsh and fish paint
 * autosuggestion ghost text (Right would accept it).
 *
 * A selection is editable only when no command is running, the session is not
 * locked, no program tracks the mouse, the buffer is the normal one, the
 * selection lies within the cursor's soft-wrapped logical line, it does not
 * reach past the cursor (that ghost text is not input), and it does not start
 * inside a recognized prompt. Every other case keeps its byte-for-byte
 * behaviour, down to xterm's own single Delete.
 */

/** Runtime state the caller owns; both must be false for an edit to go out. */
export interface SelectionGuards {
  /** A command owns the terminal; the selection is on its output or prompt. */
  commandRunning: boolean;
  /** The session has ended; keystrokes stay local. */
  locked: boolean;
}

const CURSOR_LEFT = "\x1b[D";
const CURSOR_RIGHT = "\x1b[C";
const DELETE_FORWARD = "\x1b[3~";

/** The two halves of one edit: what the shell deletes, and where it goes next. */
export interface SelectionEdit {
  /**
   * CSI D per character walked left to the selection's start, then CSI 3~ per
   * character deleted. Sent before a replacement's text, so the text lands in
   * the hole.
   */
  deleteSequence: string;
  /**
   * CSI C per character still sitting between the selection and the shell's
   * cursor. Sent after the edit (and, for a replacement, after its text) to
   * put the cursor back where it began.
   */
  restore: string;
}

/**
 * The edit for the current mouse selection, or null when the selection is not
 * one this feature may touch — in which case every input path must behave
 * exactly as it did before the feature.
 */
export function selectionEdit(term: Terminal, guards: SelectionGuards): SelectionEdit | null {
  if (guards.locked || guards.commandRunning) return null;
  // A program that tracks the mouse owns the click that made the selection;
  // sending it a cursor walk instead of the report would corrupt its input.
  if (term.modes.mouseTrackingMode !== "none") return null;
  const buf = term.buffer.active;
  if (buf.type !== "normal") return null;
  if (!term.hasSelection()) return null;
  const selection = term.getSelectionPosition();
  if (!selection) return null;

  // xterm normalizes drag directions itself (finalSelectionStart/End);
  // this is the defensive mirror in case a future version stops doing so.
  let start = selection.start;
  let end = selection.end;
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
    [start, end] = [end, start];
  }
  if (start.y === end.y && start.x === end.x) return null;

  const cols = term.cols;
  if (cols <= 0) return null;
  const cursorRow = buf.baseY + buf.cursorY;

  // The logical (soft-wrapped) line the cursor is editing: walk up over the
  // rows the terminal wrapped, mirroring TerminalCommands.cursorLine.
  let first = cursorRow;
  while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;

  // Everything outside that line is output, not the line being typed.
  if (start.y < first || end.y > cursorRow) return null;

  // Right of the cursor a remote shell paints its own autosuggestion ghost
  // text (zsh-autosuggestions, fish); it looks like input but is not.
  if (end.y * cols + end.x > cursorRow * cols + buf.cursorX) return null;

  const firstLine = buf.getLine(first);
  if (!firstLine) return null;

  // A selection may start on the trailing cell of a wide character (the
  // drag takes raw cells). The step counter reads that half as a width-0 cell,
  // so the start snaps back to the character's leading cell. The end needs no
  // snap: an exclusive end on the trailing cell already covers the character.
  const startLine = buf.getLine(start.y) ?? firstLine;
  const startCol = charStartCol(startLine, start.x);

  // With a recognized prompt the input begins after it; editing inside the
  // prompt would send left-moves the shell clamps and deletes that eat the
  // start of the typed command. An unrecognized prompt (a REPL, a device)
  // edits from column 0 and lets the shell clamp the walk.
  const promptEnd = shellPromptEnd(firstLine.translateToString(false));
  if (promptEnd >= 0 && start.y === first) {
    const before = startLine.translateToString(false, 0, startCol).length;
    if (before < promptEnd) return null;
  }

  const walkLeft = countChars(buf, cols, start.y, startCol, cursorRow, buf.cursorX);
  const deletes = countChars(buf, cols, start.y, startCol, end.y, end.x);
  if (walkLeft === null || deletes === null) return null;
  if (walkLeft === 0 && deletes === 0) return null;
  return {
    deleteSequence: CURSOR_LEFT.repeat(walkLeft) + DELETE_FORWARD.repeat(deletes),
    restore: CURSOR_RIGHT.repeat(Math.max(0, walkLeft - deletes)),
  };
}

/** The whole edit for a plain Delete/Backspace: the delete and the walk back. */
export function selectionDeleteSequence(term: Terminal, guards: SelectionGuards): string | null {
  const edit = selectionEdit(term, guards);
  return edit ? edit.deleteSequence + edit.restore : null;
}

/**
 * Sends the walk back once the replacement text has gone out. The text itself
 * is xterm's own keypress output for a printable key and `term.paste` for a
 * paste, both synchronous, so the walk lands after them in the session's byte
 * order; a task boundary is enough because nothing else is queued in between.
 */
export function scheduleSelectionRestore(term: Terminal, restore: string): void {
  if (!restore) return;
  setTimeout(() => {
    try {
      term.input(restore, true);
    } catch {
      // The pane may have closed between the keystroke and the walk back.
    }
  }, 0);
}

/** Column of the character that owns `col`: wide halves step back to the head. */
function charStartCol(line: IBufferLine, col: number): number {
  return col > 0 && line.getCell(col)?.getWidth() === 0 ? col - 1 : col;
}

/**
 * Characters between two cell positions of one logical line, counted the way
 * the shell counts cursor movement: each cell that starts a character is one
 * step. A wide character (CJK, emoji) is one step covering two cells — its
 * trailing half is a width-0 cell and is skipped — and a blank cell is the
 * space the shell echoes there. Counting cells rather than UTF-16 units is
 * what makes an astral character one character and one arrow key.
 */
function countChars(
  buf: IBuffer,
  cols: number,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
): number | null {
  let count = 0;
  for (let row = fromRow; row <= toRow; row += 1) {
    const line = buf.getLine(row);
    if (!line) return null;
    // Rows the wrap runs through are content edge to edge; only the first
    // and last segments are cut to the selection or the cursor.
    const from = row === fromRow ? fromCol : 0;
    const to = row === toRow ? toCol : cols;
    for (let col = from; col < to; col += 1) {
      const cell = line.getCell(col);
      if (!cell) return null;
      if (cell.getWidth() === 0) continue;
      count += 1;
    }
  }
  return count;
}
