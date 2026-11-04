import type { Terminal } from "@xterm/xterm";

/** Read the visible cells traversed by a drag owned by a full-screen program.
 * The program still receives every mouse event; this only supplies the quote
 * action with literal screen text, without reading the system clipboard.
 */
export function beginTerminalDrag(term: Terminal, event: MouseEvent) {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    return null;
  const { cols, rows } = term;
  const buffer = term.buffer.active;
  const viewport = buffer.viewportY;
  if (!rect.width || !rect.height || cols * rows > 256 * 1024) return null;
  const point = (e: MouseEvent) => ({
    col: Math.max(0, Math.min(cols, Math.round(((e.clientX - rect.left) * cols) / rect.width))),
    row: Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - rect.top) * rows) / rect.height))),
  });
  const start = point(event);
  const lines = Array.from({ length: rows }, (_, row) => {
    const line = buffer.getLine(viewport + row);
    return {
      wrapped: line?.isWrapped ?? false,
      cells: Array.from({ length: cols }, (_, col) => {
        const cell = line?.getCell(col);
        return cell?.getWidth() === 0 ? "" : cell?.getChars() || " ";
      }),
      text: line?.translateToString(false) ?? "",
    };
  });
  return (endEvent: MouseEvent): string => {
    if (
      term.cols !== cols ||
      term.rows !== rows ||
      term.buffer.active !== buffer ||
      buffer.viewportY !== viewport
    )
      return "";
    const end = point(endEvent);
    if (start.row === end.row && start.col === end.col) return "";
    const [first, last] =
      start.row * cols + start.col < end.row * cols + end.col ? [start, end] : [end, start];
    let result = "";
    for (let row = first.row; row <= last.row; row++) {
      const line = lines[row];
      // A repaint that only changes styling is fine. Scrolling or replacing
      // the selected text mid-gesture is ambiguous, so ask for another drag.
      if (buffer.getLine(viewport + row)?.translateToString(false) !== line.text) return "";
      if (row > first.row && !line.wrapped) result += "\n";
      let from = row === first.row ? first.col : 0;
      // A start on the trailing cell of a CJK/emoji glyph includes that glyph.
      while (from > 0 && line.cells[from] === "") from--;
      result += line.cells
        .slice(from, row === last.row ? last.col : cols)
        .join("")
        .replace(/ +$/, "");
    }
    return result;
  };
}
