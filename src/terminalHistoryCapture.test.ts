import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHistoryBatch, type HistoryRecord } from "./terminalHistory";
import { createHistoryCapture } from "./terminalHistoryCapture";
import { prependRecords } from "./terminalHistoryMaterialize";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

const SCROLLBACK = 100;
const ROWS = 24;
const COLS = 40;
const MARGIN_ROWS = 10;

/** The written form of logical line index (escape codes included). */
const written = (index: number): string => {
  if (index % 4 === 1) {
    return `\u001b[1m\u001b[38;2;10;20;30mL${index} bold-red${"y".repeat(50)}\u001b[0m\r\n`;
  }
  if (index % 5 === 0) return `L${index} 你好${"对".repeat(3 + (index % 4))}\r\n`;
  return `L${index} ${"x".repeat(3 + (index % 30))}\r\n`;
};

/** The visible logical text of line index. */
const visible = (index: number): string => {
  if (index % 4 === 1) return `L${index} bold-red${"y".repeat(50)}`;
  if (index % 5 === 0) return `L${index} 你好${"对".repeat(3 + (index % 4))}`;
  return `L${index} ${"x".repeat(3 + (index % 30))}`;
};

const reassemble = (batches: Uint8Array[]): HistoryRecord[] =>
  batches.flatMap((bytes) => decodeHistoryBatch(bytes));

type Capture = ReturnType<typeof createHistoryCapture>;

const writeLines = async (terminal: Terminal, capture: Capture, from: number, to: number) => {
  // One write per chunk of lines, the way the production stream feeds the
  // terminal: under vitest's requestAnimationFrame shim each write callback
  // waits a frame, so a per-line write would spend 16 ms per line here.
  const CHUNK = 5;
  for (let start = from; start < to; start += CHUNK) {
    const end = Math.min(start + CHUNK, to);
    let text = "";
    for (let index = start; index < end; index++) text += written(index);
    await write(terminal, text);
    capture.notifyWriteParsed();
  }
};

const consecutive = (records: HistoryRecord[]) =>
  expect(records.map((record) => record.absLine)).toEqual(records.map((_, index) => index + 1));

describe("createHistoryCapture", () => {
  it("timestamps logical records from their physical head row and clamps across batches", async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 30 });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      lineTimeAtRow: (row) => {
        const text = terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
        const index = /^T(\d+)/.exec(text);
        if (!index) return null;
        // A cursor-addressed repaint dated an older line later than a
        // following line. The codec requires nondecreasing timestamps.
        return Number(index[1]) === 20 ? 100 : 10_000 + Number(index[1]);
      },
    });
    for (let index = 0; index < 80; index += 4) {
      let content = "";
      for (let next = index; next < index + 4; next++) {
        content += `T${next} ${"x".repeat(25)}\r\n`;
      }
      await write(terminal, content);
      capture.notifyWriteParsed();
    }
    const records = reassemble(batches);
    expect(records.length).toBeGreaterThan(20);
    expect(records[0].timeMs).toBe(10_000);
    expect(records.some((record) => record.text.startsWith("T20 "))).toBe(true);
    for (let index = 1; index < records.length; index++) {
      expect(records[index].timeMs).toBeGreaterThanOrEqual(records[index - 1].timeMs);
    }
    capture.dispose();
  });

  it("reports the oldest resident exported logical line and moves it after prepend", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const capture = createHistoryCapture(terminal, { onBatch: (bytes) => batches.push(bytes) });
    expect(capture.oldestBufferedExportedAbsLine()).toBeNull();
    await writeLines(terminal, capture, 0, 300);
    const before = capture.oldestBufferedExportedAbsLine();
    expect(before).not.toBeNull();
    expect(before!).toBeGreaterThan(3);
    const restore = reassemble(batches).filter(
      (record) => record.absLine >= before! - 2 && record.absLine < before!,
    );
    expect(restore).toHaveLength(2);
    const rows = await prependRecords(terminal, restore);
    expect(rows).toBeGreaterThan(0);
    capture.notePrepended(rows);
    expect(capture.oldestBufferedExportedAbsLine()).toBe(before! - 2);
    const exportedBeforeMoreOutput = capture.exportedLines();
    await writeLines(terminal, capture, 300, 450);
    expect(capture.exportedLines()).toBeGreaterThan(exportedBeforeMoreOutput + 80);
    terminal.resize(20, ROWS);
    expect(capture.oldestBufferedExportedAbsLine()).toBeNull();
    capture.dispose();
  });

  it("exports every logical line across repeated trims without gaps or duplicates", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const onMismatch = vi.fn();
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      onMismatch,
    });
    await writeLines(terminal, capture, 0, 5 * SCROLLBACK);
    expect(onMismatch).not.toHaveBeenCalled();
    const records = reassemble(batches);
    expect(records.length).toBeGreaterThanOrEqual(5 * SCROLLBACK - 3 * MARGIN_ROWS);
    consecutive(records);
    for (let index = 0; index < records.length; index++) {
      expect(records[index].text).toBe(visible(index));
    }
    for (const record of records) {
      if ((record.absLine - 1) % 4 === 1) {
        expect(record.runs.length).toBeGreaterThan(0);
        const styled = record.runs.some((run) => (run.flags & 1) === 1 && run.fg === 0x030a141e);
        expect(styled).toBe(true);
      }
    }
    expect(capture.exportedLines()).toBe(records.length);
    expect(capture.lastExportedAbsLine()).toBe(records.length);
    capture.dispose();
  });

  it("survives a column resize (reflow) without gaps or duplicates", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const onMismatch = vi.fn();
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      onMismatch,
    });
    await writeLines(terminal, capture, 0, 300);
    expect(reassemble(batches).length).toBeGreaterThan(0);
    terminal.resize(20, ROWS);
    await writeLines(terminal, capture, 300, 600);
    expect(onMismatch).not.toHaveBeenCalled();
    const records = reassemble(batches);
    expect(records.length).toBeGreaterThan(0);
    consecutive(records);
    for (let index = 0; index < records.length; index++) {
      expect(records[index].text).toBe(visible(index));
    }
    capture.dispose();
  });

  it("preserves the resize frontier when unexported log lines repeat exported text", async () => {
    const run = async (repeat: boolean) => {
      const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
      terminals.push(terminal);
      const batches: Uint8Array[] = [];
      const onMismatch = vi.fn();
      const capture = createHistoryCapture(terminal, {
        onBatch: (bytes) => batches.push(bytes),
        onMismatch,
      });
      const append = async (from: number, to: number) => {
        for (let start = from; start < to; start += 5) {
          let chunk = "";
          for (let index = start; index < Math.min(start + 5, to); index++) {
            // Identical physical row layout in both runs. Only one varies
            // text, making the old `Set.has(text)` resync unambiguous.
            const line = repeat
              ? "R".repeat(27)
              : `R${String(index).padStart(5, "0")}${"x".repeat(21)}`;
            chunk += `${line}\r\n`;
          }
          await write(terminal, chunk);
          capture.notifyWriteParsed();
        }
      };
      await append(0, 300);
      terminal.resize(20, ROWS);
      await append(300, 600);
      const records = reassemble(batches);
      expect(onMismatch).not.toHaveBeenCalled();
      consecutive(records);
      capture.dispose();
      return records.length;
    };

    const distinctCount = await run(false);
    const repeatedCount = await run(true);
    expect(repeatedCount).toBe(distinctCount);
  });

  it("does not lose the normal history frontier when resizing in alternate screen", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const onMismatch = vi.fn();
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      onMismatch,
    });
    await writeLines(terminal, capture, 0, 300);
    await write(terminal, "\u001b[?1049h");
    capture.notifyWriteParsed();
    expect(terminal.buffer.active.type).toBe("alternate");
    terminal.resize(20, ROWS);
    // Shell output can arrive in the *same* PTY packet that exits alternate
    // screen. A lazy resync at onWriteParsed would skip this first chunk.
    let normalOutput = "\u001b[?1049l";
    for (let index = 300; index < 305; index++) normalOutput += written(index);
    await write(terminal, normalOutput);
    capture.notifyWriteParsed();
    expect(terminal.buffer.active.type).toBe("normal");
    await writeLines(terminal, capture, 305, 600);
    const records = reassemble(batches);
    expect(onMismatch).not.toHaveBeenCalled();
    consecutive(records);
    for (let index = 0; index < records.length; index++) {
      expect(records[index].text).toBe(visible(index));
    }
    capture.dispose();
  });

  it("starts a new numbering epoch after clear()", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const onMismatch = vi.fn();
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      onMismatch,
    });
    await writeLines(terminal, capture, 0, 300);
    expect(reassemble(batches).length).toBeGreaterThan(0);
    terminal.clear();
    capture.noteClear();
    batches.length = 0;
    await writeLines(terminal, capture, 300, 500);
    expect(onMismatch).not.toHaveBeenCalled();
    const records = reassemble(batches);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].absLine).toBe(1);
    consecutive(records);
    // clear() keeps the (blank) line the cursor was on, so the epoch's first
    // written line may sit at absLine 1 or 2; order is what must hold.
    const texts = records.map((record) => record.text).filter((text) => text !== "");
    expect(texts.length).toBeGreaterThan(0);
    for (let index = 0; index < texts.length; index++) {
      expect(texts[index]).toBe(visible(300 + index));
    }
    capture.dispose();
  });

  it("emits nothing while the buffer is far from the limit", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const capture = createHistoryCapture(terminal, { onBatch: (bytes) => batches.push(bytes) });
    await writeLines(terminal, capture, 0, 3);
    expect(batches).toHaveLength(0);
    expect(capture.exportedLines()).toBe(0);
    expect(capture.lastExportedAbsLine()).toBeNull();
    capture.dispose();
  });

  it("reports a mismatch when trims happen without any observation", async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminals.push(terminal);
    const batches: Uint8Array[] = [];
    const onMismatch = vi.fn();
    const capture = createHistoryCapture(terminal, {
      onBatch: (bytes) => batches.push(bytes),
      onMismatch,
    });
    // One unobserved flood: the whole 500-line write parses and trims with
    // zero notifyWriteParsed calls in between.
    let flood = "";
    for (let index = 0; index < 5 * SCROLLBACK; index++) flood += written(index);
    await write(terminal, flood);
    capture.notifyWriteParsed();
    expect(onMismatch).toHaveBeenCalledTimes(1);
    const records = reassemble(batches);
    expect(records.length).toBeGreaterThan(0);
    consecutive(records);
    capture.dispose();
  });
});
