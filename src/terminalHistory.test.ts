import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR,
  type CellSource,
  type HistoryCell,
  type HistoryRecord,
  decodeHistoryBatch,
  encodeHistoryBatch,
  logicalLineFromCells,
} from "./terminalHistory";
// The Rust suite reads the same file at test runtime; both sides must stay
// byte-identical with it.
import goldenFile from "./terminalHistory.golden.json";

const cell = (char: string, width: number, style: Partial<HistoryCell> = {}): HistoryCell => ({
  char,
  width,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  ...style,
});

const row = (...cells: (HistoryCell | null)[]): CellSource => ({
  length: cells.length,
  cellAt: (col) => cells[col] ?? null,
});

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));

const roundtrip = (records: HistoryRecord[]): HistoryRecord[] =>
  decodeHistoryBatch(encodeHistoryBatch(records));

describe("logicalLineFromCells", () => {
  it("builds an empty record from no rows", () => {
    expect(logicalLineFromCells([], { absLine: 3, timeMs: 42 })).toEqual({
      absLine: 3,
      timeMs: 42,
      text: "",
      runs: [],
    });
  });

  it("joins plain default text without emitting runs", () => {
    const record = logicalLineFromCells([row(cell("a", 1), cell("b", 1), null, cell(" ", 1))], {
      absLine: 1,
      timeMs: 1,
    });
    expect(record.text).toBe("ab");
    expect(record.runs).toEqual([]);
  });

  it("omits default segments and keeps cell coordinates across them", () => {
    const red = { fg: 0x00ff8000 };
    const record = logicalLineFromCells(
      [row(cell("a", 1, red), cell("b", 1, red), cell("c", 1), cell("d", 1), cell("e", 1, red))],
      { absLine: 1, timeMs: 1 },
    );
    expect(record.runs).toEqual([
      { start: 0, len: 2, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 0 },
      { start: 4, len: 1, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 0 },
    ]);
  });

  it("counts a wide character as two cells and keeps its surrogate pair whole", () => {
    const bold = { flags: 1 };
    const record = logicalLineFromCells(
      [row(cell("你", 2, bold), cell("🚀", 2, bold), cell("a", 1, bold))],
      { absLine: 1, timeMs: 1 },
    );
    expect(record.text).toBe("你🚀a");
    expect(record.runs).toEqual([
      { start: 0, len: 5, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 1 },
    ]);
  });

  it("skips wide-character spacer cells without advancing coordinates", () => {
    const record = logicalLineFromCells(
      [row(cell("你", 2, { flags: 8 }), cell("", 0, { flags: 8 }), cell("x", 1, { flags: 8 }))],
      { absLine: 1, timeMs: 1 },
    );
    expect(record.text).toBe("你x");
    expect(record.runs).toEqual([
      { start: 0, len: 3, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 8 },
    ]);
  });

  it("merges equal styles across a wrapped join and splits on change", () => {
    const red = { fg: 0x01000016 };
    const blue = { fg: 0x01000021 };
    const record = logicalLineFromCells(
      [row(cell("a", 1, red), cell("b", 1, red)), row(cell("c", 1, red)), row(cell("d", 1, blue))],
      { absLine: 1, timeMs: 1 },
    );
    expect(record.text).toBe("abcd");
    expect(record.runs).toEqual([
      { start: 0, len: 3, fg: 0x01000016, bg: DEFAULT_COLOR, flags: 0 },
      { start: 3, len: 1, fg: 0x01000021, bg: DEFAULT_COLOR, flags: 0 },
    ]);
  });

  it("trims trailing blanks of each physical row before joining", () => {
    const red = { fg: 0x00ff00ff };
    const record = logicalLineFromCells(
      [
        row(cell("a", 1, red), cell(" ", 1), cell(" ", 1), cell(" ", 1)),
        row(cell("b", 1, red), cell(" ", 1)),
      ],
      { absLine: 1, timeMs: 1 },
    );
    expect(record.text).toBe("ab");
    expect(record.runs).toEqual([
      { start: 0, len: 2, fg: 0x00ff00ff, bg: DEFAULT_COLOR, flags: 0 },
    ]);
  });
});

describe("encodeHistoryBatch/decodeHistoryBatch", () => {
  it("roundtrips an empty batch as exactly the four count bytes", () => {
    const bytes = encodeHistoryBatch([]);
    expect(toHex(bytes)).toBe("00000000");
    expect(roundtrip([])).toEqual([]);
  });

  it("roundtrips a record with empty text and no runs", () => {
    const records: HistoryRecord[] = [{ absLine: 1, timeMs: 0, text: "", runs: [] }];
    expect(roundtrip(records)).toEqual(records);
  });

  it("roundtrips pure ASCII with mixed runs", () => {
    const records: HistoryRecord[] = [
      {
        absLine: 1,
        timeMs: 1700000000000,
        text: "build ok 42/42",
        runs: [
          { start: 0, len: 9, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 0 },
          { start: 9, len: 5, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 8 },
        ],
      },
      { absLine: 2, timeMs: 1700000000120, text: "done", runs: [] },
    ];
    expect(roundtrip(records)).toEqual(records);
  });

  it("roundtrips CJK text with cell-coordinate runs", () => {
    const records: HistoryRecord[] = [
      {
        absLine: 5,
        timeMs: 1700000005000,
        text: "错误Error你",
        runs: [
          { start: 0, len: 4, fg: DEFAULT_COLOR, bg: 0x01000016, flags: 9 },
          { start: 4, len: 6, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 0 },
        ],
      },
    ];
    expect(roundtrip(records)).toEqual(records);
  });

  it("roundtrips truecolor, 256-color and default colors with flag combinations", () => {
    const records: HistoryRecord[] = [
      {
        absLine: 9,
        timeMs: 7,
        text: "styles",
        runs: [
          { start: 0, len: 2, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 1 | 2 },
          { start: 2, len: 2, fg: 0x01000016, bg: 0x00ffffff, flags: 4 | 8 },
          { start: 4, len: 2, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 255 },
        ],
      },
    ];
    expect(roundtrip(records)).toEqual(records);
  });

  it("roundtrips the u16 text-length boundary and rejects one byte more", () => {
    const text = "ab".repeat(32767) + "a";
    expect(text.length).toBe(65535);
    const records: HistoryRecord[] = [
      {
        absLine: 1,
        timeMs: 1,
        text,
        runs: [{ start: 0, len: 65535, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 1 }],
      },
    ];
    expect(roundtrip(records)).toEqual(records);
    const tooLong: HistoryRecord[] = [{ absLine: 1, timeMs: 1, text: `${text}x`, runs: [] }];
    expect(() => encodeHistoryBatch(tooLong)).toThrow(/u16 value out of range/);
  });

  it("roundtrips absLine jumps across varint boundaries", () => {
    const records: HistoryRecord[] = [1, 128, 128 + 127, 16384, 2000000000].map(
      (absLine): HistoryRecord => ({ absLine, timeMs: absLine * 2, text: `${absLine}`, runs: [] }),
    );
    expect(roundtrip(records)).toEqual(records);
  });

  it("rejects a time regression with the contract message", () => {
    const records: HistoryRecord[] = [
      { absLine: 10, timeMs: 2000, text: "a", runs: [] },
      { absLine: 11, timeMs: 1999, text: "back", runs: [] },
    ];
    expect(() => encodeHistoryBatch(records)).toThrow("timeMs decreased within a batch");
  });

  it("rejects absLine that does not strictly increase, on both sides", () => {
    const records: HistoryRecord[] = [
      { absLine: 10, timeMs: 2000, text: "a", runs: [] },
      { absLine: 10, timeMs: 2001, text: "same", runs: [] },
    ];
    expect(() => encodeHistoryBatch(records)).toThrow("absLine did not increase within a batch");
    // Patch the second record's absLine delta byte (offset 12) to zero.
    const bytes = encodeHistoryBatch([
      { absLine: 10, timeMs: 2000, text: "a", runs: [] },
      { absLine: 11, timeMs: 2000, text: "", runs: [] },
    ]);
    const patched = Uint8Array.from(bytes);
    patched[12] = 0;
    expect(() => decodeHistoryBatch(patched)).toThrow("absLine did not increase within a batch");
  });

  it("refuses more runs than the u16 run count can hold", () => {
    const runs = Array.from({ length: 65536 }, (_, index): HistoryRecord["runs"][number] => ({
      start: index,
      len: 1,
      fg: index,
      bg: DEFAULT_COLOR,
      flags: 0,
    }));
    expect(() => encodeHistoryBatch([{ absLine: 1, timeMs: 0, text: "x", runs }])).toThrow(
      /u16 value out of range/,
    );
  });

  it("rejects truncated batches at every prefix", () => {
    const bytes = encodeHistoryBatch([
      {
        absLine: 1,
        timeMs: 1700000000000,
        text: "hello",
        runs: [{ start: 0, len: 5, fg: 0x00ff8000, bg: DEFAULT_COLOR, flags: 1 }],
      },
    ]);
    for (let cut = 0; cut < bytes.length; cut++) {
      expect(() => decodeHistoryBatch(bytes.subarray(0, cut))).toThrow(/truncated/);
    }
    expect(decodeHistoryBatch(bytes).length).toBe(1);
  });

  it("rejects trailing bytes after the last record", () => {
    const bytes = encodeHistoryBatch([{ absLine: 1, timeMs: 0, text: "x", runs: [] }]);
    expect(() => decodeHistoryBatch(Uint8Array.from([...bytes, 0]))).toThrow(/trailing/);
  });

  it("matches the golden vectors byte-for-byte in both directions", () => {
    for (const vector of goldenFile.vectors) {
      if (vector.expectError) {
        expect(() => encodeHistoryBatch(vector.lines)).toThrow(vector.expectError);
        continue;
      }
      const hex = vector.hex;
      if (hex === null) throw new Error(`vector ${vector.name} has neither hex nor expectError`);
      expect(toHex(encodeHistoryBatch(vector.lines))).toBe(hex);
      expect(decodeHistoryBatch(fromHex(hex))).toEqual(vector.lines);
    }
  });
});
