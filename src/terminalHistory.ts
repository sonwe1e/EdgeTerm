/**
 * Logical-line serialization for terminal cold history (roadmap §2.2/§2.5,
 * decision D14). Pure functions only: no xterm imports, no IO. The xterm
 * buffer adapter (cellAt over IBufferLine) lives in the integration layer.
 *
 * Wire format, shared with the Rust reader (src-tauri history.rs) and frozen
 * by src/terminalHistory.golden.json ("edgebatch-v1"):
 *   u32 LE record count
 *   per record:
 *     varint  absLine delta from the previous record (batch starts at 0);
 *             absLine must strictly increase within a batch
 *     varint  timeMs delta from the previous record (batch starts at 0);
 *             timeMs must not decrease within a batch — encoders and decoders
 *             reject violations with "timeMs decreased within a batch"
 *     u16 LE  UTF-8 byte length of text, then the bytes (a longer line is a
 *             batch rejection, not a truncation)
 *     u16 LE  run count
 *     per run: 5 varints (start, len, fg, bg, flags)
 *
 * varints are unsigned LEB128. Colors are 32-bit packed with 0xFFFFFFFF as
 * default; flags bits are 1=bold 2=dim 4=italic 8=underline 16=blink
 * 32=inverse 64=invisible 128=strike; runs use cell coordinates (a wide
 * character spans two cells) and omit fully-default segments.
 */

/** Packed color value meaning "terminal default" (xterm's 0xFFFFFFFF). */
export const DEFAULT_COLOR = 0xffffffff;

/** One terminal cell as the integration layer reads it from the buffer. */
export interface HistoryCell {
  /** The cell's character; a surrogate pair stays in one wide cell. */
  char: string;
  /** Display width in cells: 1, 2, or 0 for a wide character's spacer. */
  width: number;
  /** Packed foreground color, DEFAULT_COLOR when unset. */
  fg: number;
  /** Packed background color, DEFAULT_COLOR when unset. */
  bg: number;
  /** SGR flag bits (see module comment). */
  flags: number;
}

/** A physical buffer line's cells, accessed lazily like xterm's getCell. */
export interface CellSource {
  length: number;
  cellAt(col: number): HistoryCell | null;
}

/** One SGR run over cells of the logical line. */
export interface HistoryRun {
  /** First cell of the run, in logical-line cell coordinates. */
  start: number;
  /** Run length in cells (a wide character counts twice). */
  len: number;
  fg: number;
  bg: number;
  flags: number;
}

/** One serialized logical line. */
export interface HistoryRecord {
  /** Absolute line number in the firstLineNumber coordinate space (from 1). */
  absLine: number;
  /** Epoch milliseconds of the line's first character (lineTimes). */
  timeMs: number;
  /** The logical line's text: wrapped continuations already joined. */
  text: string;
  /** SGR runs; fully-default segments are omitted. */
  runs: HistoryRun[];
}

const BLANK: HistoryCell = { char: " ", width: 1, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, flags: 0 };

const isDefaultStyle = (fg: number, bg: number, flags: number): boolean =>
  fg === DEFAULT_COLOR && bg === DEFAULT_COLOR && flags === 0;

/**
 * Assembles one logical line from the cells of its physical rows, in order.
 * Each row is trimmed of trailing blank cells (like translateToString(true));
 * wrapped rows join without separators, run coordinates accumulate across the
 * join, and equal styles merge. Runs covering only default styling are left
 * out; the display side treats absent coverage as default.
 */
export function logicalLineFromCells(
  rows: readonly CellSource[],
  context: { absLine: number; timeMs: number },
): HistoryRecord {
  let text = "";
  let columns = 0;
  const runs: HistoryRun[] = [];
  let open: { start: number; fg: number; bg: number; flags: number } | null = null;
  const closeOpen = () => {
    if (open === null || columns <= open.start || isDefaultStyle(open.fg, open.bg, open.flags)) {
      return;
    }
    runs.push({
      start: open.start,
      len: columns - open.start,
      fg: open.fg,
      bg: open.bg,
      flags: open.flags,
    });
  };
  for (const row of rows) {
    let end = row.length;
    while (end > 0) {
      const cell = row.cellAt(end - 1) ?? BLANK;
      if (cell.width === 1 && cell.char === " ") end -= 1;
      else break;
    }
    for (let col = 0; col < end; col++) {
      const cell = row.cellAt(col) ?? BLANK;
      const styleChanged =
        open === null || open.fg !== cell.fg || open.bg !== cell.bg || open.flags !== cell.flags;
      if (styleChanged) {
        closeOpen();
        open = { start: columns, fg: cell.fg, bg: cell.bg, flags: cell.flags };
      }
      text += cell.char;
      columns += cell.width;
    }
  }
  closeOpen();
  return { absLine: context.absLine, timeMs: context.timeMs, text, runs };
}

/** Growable output buffer for the encoder. */
class ByteWriter {
  private bytes = new Uint8Array(256);
  private size = 0;
  push(...values: number[]): void {
    this.reserve(values.length);
    for (const value of values) this.bytes[this.size++] = value;
  }
  write(source: Uint8Array): void {
    this.reserve(source.length);
    this.bytes.set(source, this.size);
    this.size += source.length;
  }
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`varint value out of range: ${value}`);
    }
    let rest = value;
    while (rest >= 0x80) {
      this.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.push(rest);
  }
  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`u16 value out of range: ${value}`);
    }
    this.push(value & 0xff, (value >>> 8) & 0xff);
  }
  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`u32 value out of range: ${value}`);
    }
    this.push(
      value & 0xff,
      ((value / 0x100) | 0) & 0xff,
      ((value / 0x10000) | 0) & 0xff,
      (value / 0x1000000) | 0,
    );
  }
  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.size);
  }
  private reserve(extra: number): void {
    if (this.size + extra <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < this.size + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.size));
    this.bytes = grown;
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Encodes records into the batch wire format (see module comment). absLine
 * must strictly increase and timeMs must not decrease within the batch;
 * violations throw before any byte of that record is written.
 */
export function encodeHistoryBatch(records: readonly HistoryRecord[]): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(records.length);
  let absLine = 0;
  let timeMs = 0;
  for (const record of records) {
    if (record.absLine <= absLine) throw new Error("absLine did not increase within a batch");
    if (record.timeMs < timeMs) throw new Error("timeMs decreased within a batch");
    writer.varint(record.absLine - absLine);
    writer.varint(record.timeMs - timeMs);
    absLine = record.absLine;
    timeMs = record.timeMs;
    const text = TEXT_ENCODER.encode(record.text);
    writer.u16(text.length);
    writer.write(text);
    writer.u16(record.runs.length);
    for (const run of record.runs) {
      writer.varint(run.start);
      writer.varint(run.len);
      writer.varint(run.fg);
      writer.varint(run.bg);
      writer.varint(run.flags);
    }
  }
  return writer.toUint8Array();
}

/** Reads a batch byte-for-byte; throws on truncation, trailing bytes and
 * delta-rule violations (the mirror of the encoder's checks). */
export function decodeHistoryBatch(batch: Uint8Array): HistoryRecord[] {
  let offset = 0;
  const byte = (): number => {
    if (offset >= batch.length) throw new Error("history batch truncated");
    return batch[offset++];
  };
  const varint = (): number => {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      const part = byte();
      value += (part & 0x7f) * multiplier;
      if ((part & 0x80) === 0) return value;
      multiplier *= 0x80;
      if (multiplier > 2 ** 42) throw new Error("history batch varint too long");
    }
  };
  const u16 = (): number => byte() | (byte() << 8);
  const u32 = (): number => byte() + byte() * 0x100 + byte() * 0x10000 + byte() * 0x1000000;
  const count = u32();
  const records: HistoryRecord[] = [];
  let absLine = 0;
  let timeMs = 0;
  for (let index = 0; index < count; index++) {
    const absDelta = varint();
    const timeDelta = varint();
    if (absDelta === 0) throw new Error("absLine did not increase within a batch");
    absLine += absDelta;
    timeMs += timeDelta;
    const byteLen = u16();
    if (offset + byteLen > batch.length) throw new Error("history batch text truncated");
    const text = TEXT_DECODER.decode(batch.subarray(offset, offset + byteLen));
    offset += byteLen;
    const runCount = u16();
    const runs: HistoryRun[] = [];
    for (let runIndex = 0; runIndex < runCount; runIndex++) {
      runs.push({ start: varint(), len: varint(), fg: varint(), bg: varint(), flags: varint() });
    }
    records.push({ absLine, timeMs, text, runs });
  }
  if (offset !== batch.length) throw new Error("history batch has trailing bytes");
  return records;
}
