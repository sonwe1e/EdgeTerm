import { type IBufferLine, Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR,
  type CellSource,
  type HistoryRecord,
  type HistoryRun,
  decodeHistoryBatch,
  logicalLineFromCells,
} from "./terminalHistory";
import { createHistoryCapture } from "./terminalHistoryCapture";
import {
  cellWidth,
  prependRecords,
  recordsToEscapes,
  sgrForRun,
} from "./terminalHistoryMaterialize";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

/** The private side of a buffer line (mirrors the capture reader). */
interface LineInternals {
  _data: Uint32Array;
  _combined?: Record<number, string>;
  length: number;
}

/**
 * A cell source over a real buffer line, mirroring the capture reader
 * (src/terminalHistoryCapture.ts) so tests can reassemble records from a
 * materialized buffer and compare them with what was exported.
 */
const cellSourceOf = (line: IBufferLine): CellSource | null => {
  const inner = (line as unknown as { _line?: LineInternals })?._line;
  if (!inner || !(inner._data instanceof Uint32Array)) return null;
  if (!Number.isInteger(inner.length) || inner._data.length !== inner.length * 3) return null;
  const data = inner._data;
  const combined = inner._combined;
  return {
    length: inner.length,
    cellAt: (col) => {
      const base = col * 3;
      const content = data[base];
      const width = (content & 0xc00000) >>> 22;
      const fg = data[base + 1];
      const bg = data[base + 2];
      const hasContent = (content & 0x3fffff) !== 0;
      const char = hasContent
        ? content & 0x200000 && combined?.[col] !== undefined
          ? combined[col]
          : String.fromCodePoint(content & 0x1fffff)
        : width === 0
          ? ""
          : " ";
      return {
        char,
        width,
        fg: (fg & 0x3000000) === 0 ? DEFAULT_COLOR : (fg & 0x3ffffff) >>> 0,
        bg: (bg & 0x3000000) === 0 ? DEFAULT_COLOR : (bg & 0x3ffffff) >>> 0,
        flags:
          (fg & 0x8000000 ? 1 : 0) |
          (bg & 0x8000000 ? 2 : 0) |
          (bg & 0x4000000 ? 4 : 0) |
          (fg & 0x10000000 ? 8 : 0) |
          (fg & 0x20000000 ? 16 : 0) |
          (fg & 0x4000000 ? 32 : 0) |
          (fg & 0x40000000 ? 64 : 0) |
          (fg & 0x80000000 ? 128 : 0),
      };
    },
  };
};

/** Records re-read from buffer rows [from, to) of a terminal. */
const reassembleRows = (terminal: Terminal, from: number, to: number) => {
  const buffer = terminal.buffer.active;
  const result: Array<{ text: string; runs: HistoryRun[] }> = [];
  let row = from;
  while (row < to) {
    const sources: CellSource[] = [];
    let end = row;
    while (end < to) {
      const line = buffer.getLine(end);
      const source = line ? cellSourceOf(line) : null;
      if (!source) throw new Error("buffer internals unavailable in test");
      sources.push(source);
      end += 1;
      const next = buffer.getLine(end);
      if (!next || !next.isWrapped) break;
    }
    const record = logicalLineFromCells(sources, { absLine: 0, timeMs: 0 });
    result.push({ text: record.text, runs: record.runs });
    row = end;
  }
  return result;
};

/** Records re-read from the first `rows` buffer rows of a terminal. */
const reassembleFrom = (terminal: Terminal, rows: number) => reassembleRows(terminal, 0, rows);

const written = (index: number): string => {
  if (index % 4 === 1) {
    return `\u001b[1m\u001b[38;2;10;20;30mL${index} bold-tc${"y".repeat(50)}\u001b[0m\r\n`;
  }
  if (index % 4 === 3) {
    return `\u001b[4m\u001b[38;5;44mL${index} under-256-${"u".repeat(20)}\u001b[0m\r\n`;
  }
  if (index % 5 === 0) return `L${index} 你好${"对".repeat(3 + (index % 4))}\r\n`;
  return `L${index} ${"x".repeat(3 + (index % 30))}\r\n`;
};

/** Captures 500 mixed lines from a real terminal and decodes the batches. */
async function capturedRecords(): Promise<HistoryRecord[]> {
  const source = new Terminal({ cols: 40, rows: 24, scrollback: 100 });
  terminals.push(source);
  const batches: Uint8Array[] = [];
  const capture = createHistoryCapture(source, {
    onBatch: (bytes) => batches.push(bytes),
    onMismatch: () => {},
  });
  for (let index = 0; index < 500; index++) {
    await write(source, written(index));
    capture.notifyWriteParsed();
  }
  capture.dispose();
  const records = batches.flatMap((bytes) => decodeHistoryBatch(bytes));
  expect(records.length).toBeGreaterThan(400);
  return records;
}

describe("sgrForRun", () => {
  it("emits nothing between equal styles", () => {
    const run: HistoryRun = { start: 0, len: 1, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 1 };
    expect(sgrForRun(run, run)).toBe("");
    expect(sgrForRun({ ...run, flags: 0 }, null)).toBe("");
  });

  it("maps colors and flag transitions", () => {
    expect(sgrForRun({ start: 0, len: 1, fg: 0x030a141e, bg: DEFAULT_COLOR, flags: 0 }, null)).toBe(
      "\u001b[38;2;10;20;30m",
    );
    expect(sgrForRun({ start: 0, len: 1, fg: DEFAULT_COLOR, bg: 0x0200002c, flags: 0 }, null)).toBe(
      "\u001b[48;5;44m",
    );
    expect(
      sgrForRun(
        { start: 0, len: 1, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 0 },
        { start: 0, len: 1, fg: 0x030a141e, bg: DEFAULT_COLOR, flags: 0 },
      ),
    ).toBe("\u001b[39m");
    expect(
      sgrForRun(
        { start: 0, len: 1, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 8 },
        { start: 0, len: 1, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 1 },
      ),
    ).toBe("\u001b[4;22m");
  });
});

describe("recordsToEscapes", () => {
  it("styles runs at cell positions and resets between gaps", () => {
    const escapes = recordsToEscapes([
      {
        absLine: 1,
        timeMs: 0,
        text: "abcdef",
        runs: [
          { start: 1, len: 2, fg: 0x030a141e, bg: DEFAULT_COLOR, flags: 0 },
          { start: 4, len: 2, fg: DEFAULT_COLOR, bg: 0x0200002c, flags: 0 },
        ],
      },
    ]);
    expect(escapes).toBe("a\u001b[38;2;10;20;30mbc\u001b[39md\u001b[48;5;44mef\u001b[0m");
  });
});

describe("prependRecords", () => {
  it("materializes captured records with text and styles intact", async () => {
    const records = await capturedRecords();
    const target = new Terminal({ cols: 40, rows: 24, scrollback: 2000 });
    terminals.push(target);
    const before = target.buffer.active.length;
    const prepended = await prependRecords(target, records);
    expect(prepended).toBeGreaterThan(records.length);
    expect(target.buffer.active.length).toBe(before + prepended);
    const reassembled = reassembleFrom(target, prepended);
    expect(reassembled.length).toBe(records.length);
    for (let index = 0; index < records.length; index++) {
      expect(reassembled[index].text).toBe(records[index].text);
      expect(reassembled[index].runs).toEqual(records[index].runs);
    }
  }, 30000);

  it("re-wraps records at the target's columns", async () => {
    const records = await capturedRecords();
    const narrow = new Terminal({ cols: 20, rows: 24, scrollback: 4000 });
    terminals.push(narrow);
    const prepended = await prependRecords(narrow, records);
    const expectedRows = records.reduce(
      (sum, record) => sum + Math.max(1, Math.ceil(cellWidth(record.text) / 20)),
      0,
    );
    expect(prepended).toBe(expectedRows);
    const reassembled = reassembleFrom(narrow, prepended);
    expect(reassembled.length).toBe(records.length);
    for (let index = 0; index < records.length; index++) {
      expect(reassembled[index].text).toBe(records[index].text);
      expect(reassembled[index].runs).toEqual(records[index].runs);
    }
  }, 30000);

  it("resolves 0 for empty records without touching the terminal", async () => {
    const target = new Terminal({ cols: 40, rows: 24, scrollback: 100 });
    terminals.push(target);
    const before = target.buffer.active.length;
    expect(await prependRecords(target, [])).toBe(0);
    expect(target.buffer.active.length).toBe(before);
  });

  it("prepends a second batch above the first and leaves a usable terminal", async () => {
    const records = await capturedRecords();
    const target = new Terminal({ cols: 40, rows: 24, scrollback: 4000 });
    terminals.push(target);
    const first = await prependRecords(target, records.slice(0, 200));
    const second = await prependRecords(target, records.slice(200, 400));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    // The second batch sits above the first; both keep their order.
    const upper = reassembleFrom(target, second);
    const lower = reassembleRows(target, second, second + first);
    expect(upper.length).toBe(200);
    expect(lower.length).toBe(200);
    for (let index = 0; index < 200; index++) {
      expect(upper[index].text).toBe(records[200 + index].text);
      expect(lower[index].text).toBe(records[index].text);
    }
    // The terminal still accepts writes after materialization.
    await write(target, "tail\r\n");
    const tail = target.buffer.active.getLine(target.buffer.active.length - 1);
    expect(tail?.translateToString(true)).toBe("");
  }, 30000);
});
