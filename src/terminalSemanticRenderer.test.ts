import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalSemanticRenderer } from "./terminalSemanticRenderer";

const terminals: Terminal[] = [];
const renderers: TerminalSemanticRenderer[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.stopBacklog();
  for (const terminal of terminals.splice(0)) terminal.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve));
}

async function wrappedBuffer(scrollback: number, alternate: boolean) {
  const term = new Terminal({ cols: 8, rows: 3, scrollback, allowProposedApi: true });
  terminals.push(term);
  if (alternate) await write(term, "\x1b[?1049h");
  // Enough soft wraps to discard the original, unwrapped first row. Every
  // retained row now continues the same logical line, even at buffer index 0.
  await write(term, "abcdefgh".repeat(10));
  const buffer = term.buffer.active;
  expect(buffer.length).toBe(alternate ? 3 : 3 + scrollback);
  for (let row = 0; row < buffer.length; row++) {
    expect(buffer.getLine(row)?.isWrapped).toBe(true);
  }
  const renderer = new TerminalSemanticRenderer({ term, visible: true, disposed: false });
  renderers.push(renderer);
  return { term, buffer, renderer };
}

/** Fail an invalid walk synchronously instead of hanging the test process. */
function guardBufferReads(buffer: Terminal["buffer"]["active"]) {
  const getLine = buffer.getLine.bind(buffer);
  return vi.spyOn(buffer, "getLine").mockImplementation((row) => {
    if (row < 0 || row >= buffer.length) {
      throw new Error(`Semantic coloring read row ${row} outside ${buffer.length} rows`);
    }
    return getLine(row);
  });
}

describe("semantic coloring at the end of xterm's circular buffer", () => {
  it("keeps a viewport refresh bounded when one logical line fills a long history", async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
    terminals.push(term);
    await write(term, "x".repeat(800000));
    const renderer = new TerminalSemanticRenderer({ term, visible: true, disposed: false });
    renderers.push(renderer);
    const reads = guardBufferReads(term.buffer.active);
    const start = performance.now();
    renderer.refreshSemanticColors();
    const elapsed = performance.now() - start;
    console.info(
      `Long-line viewport: ${reads.mock.calls.length} row reads, ${elapsed.toFixed(2)} ms`,
    );
    expect(reads.mock.calls.length).toBeLessThan(5000);
    expect(term.buffer.active.getLine(9999)?.translateToString(true)).toBe("x".repeat(80));
    reads.mockRestore();
    await write(term, "\r\n10.0.0.1\r\n");
    renderer.refreshSemanticColors();
    expect(
      term.buffer.active
        .getLine(term.buffer.active.baseY + term.buffer.active.cursorY - 1)
        ?.getCell(0)
        ?.getFgColor(),
    ).toBe(0x5fd7c0);
  });
  it.each([
    { name: "normal screen without scrollback", scrollback: 0, alternate: false },
    { name: "full normal scrollback", scrollback: 2, alternate: false },
    { name: "alternate screen", scrollback: 2, alternate: true },
  ])(
    "finishes a viewport pass over an entirely wrapped $name",
    async ({ scrollback, alternate }) => {
      const { term, buffer, renderer } = await wrappedBuffer(scrollback, alternate);
      const reads = guardBufferReads(buffer);
      expect(() => renderer.refreshSemanticColors()).not.toThrow();
      expect(reads).toHaveBeenCalled();
      for (let row = 0; row < buffer.length; row++) {
        expect(buffer.getLine(row)?.translateToString(true)).toBe("abcdefgh");
      }

      // The next output still parses and receives semantic colors normally.
      reads.mockRestore();
      await write(term, "\r\n10.0.0.1\r\n");
      guardBufferReads(buffer);
      renderer.refreshSemanticColors();
      const ip = buffer.getLine(buffer.baseY + buffer.cursorY - 1);
      expect(ip?.translateToString(true)).toBe("10.0.0.1");
      expect(ip?.getCell(0)?.getFgColor()).toBe(0x5fd7c0);
    },
  );

  it("finishes the deferred history pass when the oldest line was trimmed mid-wrap", async () => {
    const { buffer, renderer } = await wrappedBuffer(2, false);
    const reads = guardBufferReads(buffer);
    vi.useFakeTimers();
    renderer.scheduleBacklog();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(reads).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
