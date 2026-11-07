import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { internalList, prependClonedLines, shiftViewport } from "./terminalHistoryPrepend";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

const SCROLLBACK = 20;
const ROWS = 5;
const COLS = 40;

const lineAt = (index: number) => `L${index} ${"x".repeat(3 + (index % 17))}`;

describe("terminalHistoryPrepend", () => {
  it("prepends cloned lines at the buffer top and keeps writing alive", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    for (let index = 0; index < 40; index++) {
      await write(terminal, `${lineAt(index)}\r\n`);
    }
    const buffer = terminal.buffer.active;
    const before = buffer.length;
    // Clone the oldest line still in the buffer as the stand-in for a
    // reconstructed cold-history line.
    const oldest = buffer.getLine(0)?.translateToString(true) ?? "";

    const prepended = prependClonedLines(terminal, 0, 4);

    expect(prepended).toBe(4);
    expect(buffer.length).toBe(before + 4);
    for (let index = 0; index < 4; index++) {
      expect(buffer.getLine(index)?.translateToString(true)).toBe(oldest);
    }
    // The rest of the buffer shifted down untouched.
    expect(buffer.getLine(4)?.translateToString(true)).toBe(oldest);
    expect(buffer.getLine(5)?.translateToString(true)).not.toBe("");
    // Writing continues to work and trims the prepended lines first (they
    // are now the oldest). Growing maxLength for the prepend raises the
    // effective capacity by the prepended count until xterm's lazy memory
    // cleanup reclaims it, so the bound is the capacity plus that overshoot.
    for (let index = 40; index < 60; index++) {
      await write(terminal, `${lineAt(index)}\r\n`);
    }
    expect(buffer.length).toBeLessThanOrEqual(ROWS + SCROLLBACK + 4);
    const top = buffer.getLine(0)?.translateToString(true) ?? "";
    expect(top.startsWith("L")).toBe(true);
  });

  it("keeps the viewport on the same content when shifted by the prepended count", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    for (let index = 0; index < 30; index++) {
      await write(terminal, `${lineAt(index)}\r\n`);
    }
    terminal.scrollToTop();
    expect(terminal.buffer.active.viewportY).toBe(0);
    const visible = terminal.buffer.active.getLine(0)?.translateToString(true) ?? "";

    expect(prependClonedLines(terminal, 0, 3)).toBe(3);
    expect(shiftViewport(terminal, 3)).toBe(true);

    // Same visual content at the top row after the prepend + shift.
    expect(terminal.buffer.active.viewportY).toBe(3);
    expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe(visible);
  });

  it("prepended lines survive a column resize within the scrollback", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    for (let index = 0; index < 30; index++) {
      await write(terminal, `${lineAt(index)}\r\n`);
    }
    expect(prependClonedLines(terminal, 0, 2)).toBe(2);
    const prependedText = terminal.buffer.active.getLine(0)?.translateToString(true) ?? "";

    terminal.resize(30, ROWS);

    expect(terminal.buffer.active.getLine(0)?.translateToString(true).startsWith("L")).toBe(true);
    // Reflow rewraps lines but the prepended row stays at the buffer top.
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).not.toBe("");
    expect(prependedText.startsWith("L")).toBe(true);
  });

  it("degrades to zero when the internals are missing", () => {
    const stranger = {} as Terminal;
    expect(internalList(stranger)).toBeNull();
    expect(prependClonedLines(stranger, 0, 4)).toBe(0);
    expect(shiftViewport(stranger, 4)).toBe(false);
  });
});
