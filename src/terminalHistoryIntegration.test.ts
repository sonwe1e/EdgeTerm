import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { decodeHistoryBatch, type HistoryRecord } from "./terminalHistory";
import { TerminalColdHistory } from "./terminalHistoryIntegration";

vi.mock("./bindings", () => ({
  commands: {
    historyAppend: vi.fn(),
    historyReadBefore: vi.fn(),
    historyClear: vi.fn(),
  },
}));

const append = vi.mocked(commands.historyAppend);
const readBefore = vi.mocked(commands.historyReadBefore);
const clear = vi.mocked(commands.historyClear);
const live: Array<{ term: Terminal; history: TerminalColdHistory }> = [];
let stored: HistoryRecord[] = [];

const write = (term: Terminal, text: string) =>
  new Promise<void>((resolve) => term.write(text, resolve));

const outcome = (count: number) => ({ storedLines: count, droppedLines: 0, totalRecords: count });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Enough separate parse observations to exercise the pre-trim capture frontier. */
async function flood(term: Terminal, history: TerminalColdHistory, from: number, to: number) {
  for (let start = from; start < to; start += 10) {
    let output = "";
    for (let index = start; index < Math.min(start + 10, to); index++) {
      output += `cold-line-${index}\r\n`;
    }
    await write(term, output);
    history.outputParsed();
  }
}

function setup(options: { interactive?: () => boolean } = {}) {
  const term = new Terminal({ cols: 40, rows: 8, scrollback: 100 });
  const element = document.createElement("div");
  const prepend = vi.fn<(rows: number, records: readonly HistoryRecord[]) => void>();
  const notices = vi.fn<(notice: string) => void>();
  const history = new TerminalColdHistory({
    terminal: term,
    sessionId: "history-test",
    enabled: () => true,
    interactiveProgramActive: options.interactive,
    onPrepended: prepend,
    onNotice: notices,
  });
  history.attachWheel(element);
  live.push({ term, history });
  const wheel = () => {
    term.scrollToTop();
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  };
  return { term, history, wheel, prepend, notices };
}

beforeEach(() => {
  stored = [];
  append.mockReset();
  readBefore.mockReset();
  clear.mockReset();
  append.mockImplementation(async (_id, bytes) => {
    const batch = decodeHistoryBatch(Uint8Array.from(bytes));
    if (batch.length && stored.length && batch[0].absLine <= stored[stored.length - 1].absLine) {
      throw new Error("out-of-order history append");
    }
    stored.push(...batch);
    return outcome(stored.length);
  });
  readBefore.mockImplementation(async (_id, before, max) =>
    stored
      .filter((record) => record.absLine < before)
      .slice(-max)
      .reverse(),
  );
  clear.mockImplementation(async () => {
    stored = [];
    return null;
  });
});

afterEach(async () => {
  for (const { history, term } of live.splice(0)) {
    history.dispose();
    term.dispose();
  }
  await Promise.resolve();
});

describe("TerminalColdHistory integration", () => {
  it("reads disjoint cold-only pages without re-inserting exported hot lines", async () => {
    const { term, history, wheel, prepend } = setup();
    await flood(term, history, 0, 1050);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(900));
    // The exporter is deliberately ahead of the actual hot buffer trim.
    // A naive newest-first read would place the newest 500 records twice.
    expect(stored.some((record) => record.text === "cold-line-1000")).toBe(true);
    const originallyHot = new Set(
      Array.from({ length: term.buffer.normal.length }, (_, i) =>
        term.buffer.normal.getLine(i)?.translateToString(true),
      ),
    );
    expect(originallyHot.has("cold-line-1000")).toBe(true);

    wheel();
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
    const firstPage = prepend.mock.calls[0][1];
    expect(firstPage).toHaveLength(500);
    expect(firstPage[0].absLine).toBeLessThan(firstPage[firstPage.length - 1].absLine);
    expect(firstPage[firstPage.length - 1].absLine).toBeLessThan(readBefore.mock.calls[0][1]);
    expect(firstPage.every((record) => !originallyHot.has(record.text))).toBe(true);

    wheel();
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(2));
    const secondPage = prepend.mock.calls[1][1];
    expect(secondPage.length).toBeGreaterThan(0);
    expect(secondPage[secondPage.length - 1].absLine).toBeLessThan(firstPage[0].absLine);
    const ids = [...firstPage, ...secondPage].map((record) => record.absLine);
    expect(new Set(ids).size).toBe(ids.length);

    wheel();
    await Promise.resolve();
    // A short final page marks the current top exhausted until more output
    // makes additional exported records leave the hot window.
    expect(readBefore).toHaveBeenCalledTimes(2);
    expect(prepend).toHaveBeenCalledTimes(2);
  }, 30000);

  it("never reads or prepends cold history while an Agent owns the screen", async () => {
    let agentActive = false;
    const { term, history, wheel, prepend } = setup({ interactive: () => agentActive });
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));
    await write(term, "\x1b[?1049h\x1b[H\x1b[2Jagent UI");
    wheel();
    expect(readBefore).not.toHaveBeenCalled();
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain("agent UI");

    await write(term, "\x1b[?1049l");
    agentActive = true; // oh-my-pi can draw its TUI in the normal buffer.
    wheel();
    expect(readBefore).not.toHaveBeenCalled();
    expect(prepend).not.toHaveBeenCalled();
  }, 30000);

  it("rejects an in-flight page when the Agent switches buffers during IPC", async () => {
    const { term, history, wheel, prepend } = setup();
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));
    const gate = deferred<HistoryRecord[]>();
    readBefore.mockImplementationOnce(() => gate.promise);
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(1));
    await write(term, "\x1b[?1049h\x1b[Hagent UI");
    gate.resolve(stored.slice(0, 5).reverse());
    await Promise.resolve();
    await Promise.resolve();
    expect(prepend).not.toHaveBeenCalled();
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toContain("agent UI");
  }, 30000);

  it("rejects an in-flight page when oh-my-pi takes over the normal buffer", async () => {
    let agentActive = false;
    const { term, history, wheel, prepend } = setup({ interactive: () => agentActive });
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));

    const gate = deferred<HistoryRecord[]>();
    readBefore.mockImplementationOnce(() => gate.promise);
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(1));
    const beforeLength = term.buffer.normal.length;

    // oh-my-pi can repaint in the normal buffer without an alternate-screen
    // switch. A page requested just before its takeover must not be spliced
    // into that screen, even though the IPC response is otherwise valid.
    agentActive = true;
    expect(term.buffer.active.type).toBe("normal");
    gate.resolve(stored.slice(0, 5).reverse());
    await Promise.resolve();
    await Promise.resolve();
    expect(prepend).not.toHaveBeenCalled();
    expect(term.buffer.normal.length).toBe(beforeLength);

    wheel();
    expect(readBefore).toHaveBeenCalledTimes(1);

    // Leaving the Agent re-enables history loading; the canceled request
    // must not incorrectly mark the cold store as exhausted.
    agentActive = false;
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
  }, 30000);

  it("discards an in-flight wrapped page after a column resize", async () => {
    const { term, history, wheel, prepend } = setup();
    term.resize(18, 8);
    await flood(term, history, 0, 350);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(150));

    const gate = deferred<HistoryRecord[]>();
    readBefore.mockImplementationOnce(() => gate.promise);
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(1));
    const previousBound = readBefore.mock.calls[0][1];

    // The old page was selected for 18 columns. After a resize to 8, many
    // records have a different physical row count and must be re-parsed.
    term.resize(8, 8);
    expect(
      Array.from(
        { length: term.buffer.normal.length },
        (_, row) => term.buffer.normal.getLine(row)?.isWrapped,
      ).some(Boolean),
    ).toBe(true);
    const resizedLength = term.buffer.normal.length;
    gate.resolve(
      stored
        .filter((record) => record.absLine < previousBound)
        .slice(-5)
        .reverse(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(prepend).not.toHaveBeenCalled();
    expect(term.buffer.normal.length).toBe(resizedLength);

    // A subsequent parser observation resolves the resize frontier; a fresh
    // wheel can then fetch a page at the current width.
    await write(term, "\u001b[0m");
    history.outputParsed();
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
  }, 30000);

  it("discards a pending page when concurrent output advances the hot/cold seam", async () => {
    const { term, history, wheel, prepend } = setup();
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));
    const gate = deferred<HistoryRecord[]>();
    readBefore.mockImplementationOnce(() => gate.promise);
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(1));
    const staleBound = readBefore.mock.calls[0][1];

    await flood(term, history, 220, 330);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(210));
    expect(history.coldSearchBeforeAbs()).toBeGreaterThan(staleBound);

    gate.resolve(
      stored
        .filter((record) => record.absLine < staleBound)
        .slice(-5)
        .reverse(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(prepend).not.toHaveBeenCalled();

    // A fresh wheel reads the new seam, rather than reusing the stale page.
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
    expect(readBefore.mock.calls[1][1]).toBeGreaterThan(staleBound);
  }, 30000);

  it("unlocks an exhausted cold page after further output trims the buffer", async () => {
    const { term, history, wheel, prepend, notices } = setup();
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));
    wheel();
    await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
    expect(prepend.mock.calls[0][1].length).toBeLessThan(500);
    wheel();
    expect(readBefore).toHaveBeenCalledTimes(1);

    await flood(term, history, 220, 550);
    await vi.waitFor(() =>
      expect(stored.length, JSON.stringify(notices.mock.calls)).toBeGreaterThan(400),
    );
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(2));
  }, 30000);

  it("does not insert an obsolete pending page after clear changes the history epoch", async () => {
    const { term, history, wheel, prepend } = setup();
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(stored.length).toBeGreaterThan(100));
    const gate = deferred<HistoryRecord[]>();
    readBefore.mockImplementationOnce(() => gate.promise);
    wheel();
    await vi.waitFor(() => expect(readBefore).toHaveBeenCalledTimes(1));
    history.cleared();
    gate.resolve(stored.slice(0, 5).reverse());
    await Promise.resolve();
    await Promise.resolve();
    expect(prepend).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  }, 30000);

  it("serializes asynchronous appends and clear instead of racing with new epochs", async () => {
    const { term, history } = setup();
    const gate = deferred<ReturnType<typeof outcome>>();
    append.mockImplementationOnce(() => gate.promise);
    await flood(term, history, 0, 220);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    expect(stored).toHaveLength(0);
    history.cleared();
    expect(clear).not.toHaveBeenCalled();
    gate.resolve(outcome(1));
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    // Older queued batches belong to the previous epoch and do not append
    // after the clear, even though they were captured before it.
    expect(append).toHaveBeenCalledTimes(1);
  }, 30000);
});
