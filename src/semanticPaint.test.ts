import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { internalLine, paintable, PAINTED } from "./semanticPaint";
const write = (term: Terminal, text: string) =>
  new Promise<void>((resolve) => term.write(text, resolve));

describe("locked xterm 6 buffer contract", () => {
  it("checks actual RGB words, Unicode cells and resize views", async () => {
    const term = new Terminal({ cols: 8, rows: 2, allowProposedApi: true });
    try {
      await write(term, "\x1b[38;2;17;34;51;48;2;68;85;102mA界e\u0301");
      const line = term.buffer.active.getLine(0)!;
      const raw = internalLine(line)!;
      expect(
        raw,
        "xterm private layout changed: inspect BufferLine and semanticPaint before upgrading",
      ).not.toBeNull();
      expect(raw._data.length).toBe(24);
      expect(Array.from(raw._data.slice(0, 3))).toEqual([(1 << 22) | 65, 0x3112233, 0x3445566]);
      expect(line.getCell(1)!.getWidth()).toBe(2);
      expect(line.getCell(3)!.getChars()).toBe("e\u0301");
      expect(paintable(term)).toBe(true);
      term.resize(12, 2);
      expect(internalLine(term.buffer.active.getLine(0))!._data.length).toBe(36);
      term.resize(5, 2);
      expect(internalLine(term.buffer.active.getLine(0))!._data.length).toBe(15);
    } finally {
      term.dispose();
    }
  });
  it("leaves BG highest bit free across real SGR and extended attributes", async () => {
    const cases: [string, number, number][] = [
      ["1", 1, 0x08000000],
      ["4", 1, 0x10000000],
      ["7", 1, 0x04000000],
      ["5", 1, 0x20000000],
      ["8", 1, 0x40000000],
      ["9", 1, 0x80000000],
      ["3", 2, 0x04000000],
      ["2", 2, 0x08000000],
      ["4:3", 2, 0x10000000],
      ["53", 2, 0x40000000],
    ];
    expect(PAINTED).toBe(0x80000000);
    for (const [sgr, word, flag] of cases) {
      const term = new Terminal({ cols: 8, rows: 2, allowProposedApi: true });
      try {
        await write(term, `\x1b[${sgr}mX`);
        const raw = internalLine(term.buffer.active.getLine(0))!._data;
        expect((raw[word] & flag) >>> 0, `SGR ${sgr} flag moved`).toBe(flag);
        expect((raw[2] & 0x80000000) >>> 0, `SGR ${sgr} collides with semantic paint`).toBe(0);
      } finally {
        term.dispose();
      }
    }
    const term = new Terminal({ cols: 8, rows: 2, allowProposedApi: true });
    try {
      await write(term, '\x1b[1"qX');
      expect((internalLine(term.buffer.active.getLine(0))!._data[2] & 0x20000000) >>> 0).toBe(
        0x20000000,
      );
    } finally {
      term.dispose();
    }
  });
  it("rejects unknown strides instead of indexing them as three words", () => {
    const view = (words: number) =>
      ({ _line: { length: 8, _data: new Uint32Array(words) } }) as unknown as Parameters<
        typeof internalLine
      >[0];
    expect(internalLine(view(24))).not.toBeNull();
    expect(internalLine(view(32))).toBeNull();
    expect(internalLine(view(20))).toBeNull();
  });
});
