import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "./terminalHistory";
import { prependRecords } from "./terminalHistoryMaterialize";
import { TerminalLineGutter } from "./terminalLineGutter";

const terminals: Terminal[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function createGutter(cols: number, rows: number, scrollback: number) {
  const term = new Terminal({ cols, rows, scrollback });
  terminals.push(term);
  const element = document.createElement("div");
  const gutter = new TerminalLineGutter({
    term,
    gutter: element,
    host: document.createElement("div"),
    gutterMode: "both",
    agentSessionActive: false,
    scrollback,
  });
  gutter.cellHeight = 16;
  term.onLineFeed(() => gutter.recordLine());
  term.onWriteParsed(() => gutter.outputParsed());
  return { term, gutter, element };
}

const write = (term: Terminal, text: string) =>
  new Promise<void>((resolve) => term.write(text, resolve));

describe("cold-history gutter metadata", () => {
  it("maps timestamps to physical wraps and preserves old hot line identities", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(50_000);
    const { term, gutter } = createGutter(8, 4, 10);
    await write(term, "warm\r\nhot\r\n");
    const hotTime = gutter.timestampAtPhysicalRow(1);
    const oldFirst = gutter.firstLineNumber;
    const records: HistoryRecord[] = [
      { absLine: 11, timeMs: 10_000, text: "abcdefghijkl", runs: [] },
      { absLine: 12, timeMs: 20_000, text: "short", runs: [] },
    ];
    const added = await prependRecords(term, records);
    expect(added).toBe(3);
    gutter.prependHistoryRows(added, records);
    expect([0, 1, 2].map((row) => gutter.timestampAtPhysicalRow(row))).toEqual([
      10_000, 10_000, 20_000,
    ]);
    expect(gutter.timestampAtPhysicalRow(added + 1)).toBe(hotTime);
    expect(gutter.firstLineNumber + added + 1).toBe(oldFirst + 1);
  });

  it("does not trim prepended metadata while those rows remain in xterm's expanded buffer", async () => {
    const { term, gutter } = createGutter(20, 4, 2);
    await write(term, "warm\r\nhot\r\n");
    const records: HistoryRecord[] = Array.from({ length: 10 }, (_, index) => ({
      absLine: index + 1,
      timeMs: 10_000 + index,
      text: `cold ${index}`,
      runs: [],
    }));
    const added = await prependRecords(term, records);
    expect(added).toBe(10);
    gutter.prependHistoryRows(added, records);
    const first = gutter.firstLineNumber;
    expect(gutter.lineCount).toBeGreaterThan(term.rows + 2);
    gutter.trimLineMetadata();
    expect(gutter.firstLineNumber).toBe(first);
    expect(gutter.timestampAtPhysicalRow(9)).toBe(10_009);
  });

  it("shows unknown timestamps as a placeholder on cold rows", async () => {
    const { term, gutter, element } = createGutter(20, 4, 5);
    const records: HistoryRecord[] = [{ absLine: 1, timeMs: 0, text: "restored", runs: [] }];
    const added = await prependRecords(term, records);
    expect(added).toBe(1);
    gutter.prependHistoryRows(added, records);
    term.scrollToTop();
    gutter.syncGutter();
    expect(element.querySelector(".gutter-time")?.textContent).toBe("[--:--:--.---]");
  });
});
