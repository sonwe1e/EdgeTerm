// Structural diagnostic for EdgeTerm A2 cold-history prepend memory.
//
// Uses xterm 6's actual CircularList.splice/maxLength and BufferLine data,
// with the same scratch-terminal row transfer and ybase/ydisp adjustment as
// terminalHistoryMaterialize.ts. This is NOT a cold-history integration test:
// no Tauri, Rust, capture/codec, browser renderer, network or real Agent TUI.
// It deliberately shows what repeated prepends do to the live xterm buffer.
//
// Run (from the repository root or an isolated worktree):
//   node --expose-gc scripts/measure-cold-history-jsdom.mjs \
//     --hot=10000 --pages=40 --page-lines=500 --cols=80 \
//     --max-buffer-mb=128 --out=/tmp/cold-history-structural.json
//
// --max-buffer-mb limits the estimated live xterm cell backing store BEFORE
// each allocation; it is an abort guard, not a process-RSS hard limit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Worktrees intentionally do not link node_modules. Resolve dependencies
// through the already-installed parent checkout without changing either.
const root = [resolve(scriptDir, ".."), resolve(scriptDir, "../../..")].find((candidate) =>
  existsSync(join(candidate, "node_modules/@xterm/xterm/lib/xterm.js")),
);
assert.ok(root, "cannot find installed @xterm/xterm (run npm ci in the parent checkout)");
const require = createRequire(join(root, "package.json"));
const { JSDOM } = require("jsdom");

const USAGE =
  "usage: measure-cold-history-jsdom.mjs [--cols=80] [--hot=10000] " +
  "[--pages=40] [--page-lines=500] [--max-buffer-mb=128] [--out=PATH]";

function parseOptions(argv) {
  const values = { cols: 80, hot: 10000, pages: 40, pageLines: 500, maxBufferMb: 128 };
  const names = {
    cols: "cols",
    hot: "hot",
    pages: "pages",
    "page-lines": "pageLines",
    "max-buffer-mb": "maxBufferMb",
  };
  let out = null;
  for (let index = 0; index < argv.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match) throw new Error(`unexpected argument ${argv[index]}\n${USAGE}`);
    const key = match[1];
    const value = match[2] ?? argv[++index];
    if (value === undefined || value === "")
      throw new Error(`missing value for --${key}\n${USAGE}`);
    if (key === "out") {
      if (out !== null) throw new Error("--out provided twice");
      out = resolve(value);
    } else if (key in names) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`invalid number for --${key}: ${value}`);
      values[names[key]] = parsed;
    } else {
      throw new Error(`unknown option --${key}\n${USAGE}`);
    }
  }
  for (const [name, min, max] of [
    ["cols", 20, 500],
    ["hot", 24, 200000],
    ["pages", 0, 2000],
    ["pageLines", 1, 2048],
  ]) {
    if (!Number.isInteger(values[name]) || values[name] < min || values[name] > max) {
      throw new Error(`--${name === "pageLines" ? "page-lines" : name} must be ${min}..${max}`);
    }
  }
  if (!(values.maxBufferMb > 0 && values.maxBufferMb <= 4096)) {
    throw new Error("--max-buffer-mb must be >0 and <=4096");
  }
  return { ...values, out };
}

const options = parseOptions(process.argv.slice(2));
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.self = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
// No canvas rendering is measured. xterm's font probe asks for a canvas
// context; jsdom otherwise logs a misleading "Not implemented" warning.
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

// Load the shipped CommonJS bundle only after installing DOM globals.
const { Terminal } = require("@xterm/xterm");
const xtermBundle = await readFile(join(root, "node_modules/@xterm/xterm/lib/xterm.js"));
const xtermVersion = require("@xterm/xterm/package.json").version;
const millis = () => performance.now();
const MB = 1e6;
const snapshot = (rows, cols) => {
  globalThis.gc?.();
  globalThis.gc?.();
  const mem = process.memoryUsage();
  return {
    rssMB: +(mem.rss / MB).toFixed(3),
    heapUsedMB: +(mem.heapUsed / MB).toFixed(3),
    externalMB: +(mem.external / MB).toFixed(3),
    arrayBuffersMB: +(mem.arrayBuffers / MB).toFixed(3),
    // @xterm/xterm 6 eagerly allocates Uint32Array(cols * 3) per live row.
    estimatedXtermCellMB: +((rows * cols * 12) / MB).toFixed(3),
  };
};
const write = (term, data) => new Promise((done) => term.write(data, done));
const text = (term, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? null;
const internals = (term) => {
  const buffer = term?._core?._bufferService?.buffer;
  const list = buffer?.lines;
  assert.ok(buffer && list && typeof list.splice === "function" && typeof list.get === "function");
  assert.ok(Number.isInteger(list.maxLength) && Number.isInteger(list.length));
  assert.ok(Number.isInteger(buffer.ybase) && Number.isInteger(buffer.ydisp));
  return { buffer, list };
};

class MemoryAbort extends Error {}

async function appendScratchRows(target, page, count, cols, maxBufferMb) {
  const { buffer, list } = internals(target);
  // Each generated row occupies one physical line. Check memory BEFORE the
  // scratch parser and splice so an accidental large run exits safely.
  const predictedCellMb = ((list.length + count + count + 2) * cols * 12) / MB;
  if (predictedCellMb > maxBufferMb) {
    throw new MemoryAbort(
      `prepending page ${page} would need >=${predictedCellMb.toFixed(3)} MB of xterm cell ` +
        `backing stores (cap ${maxBufferMb} MB), including temporary scratch rows`,
    );
  }
  const scratch = new Terminal({ cols, rows: 2, scrollback: count + 8 });
  const prepared = [];
  let parseMs = 0;
  let spliceMs = 0;
  try {
    const payload = Array.from({ length: count }, (_, index) => `cold-${page}-${index}`).join(
      "\r\n",
    );
    const parseStarted = millis();
    await write(scratch, payload);
    parseMs = millis() - parseStarted;
    const { list: scratchList } = internals(scratch);
    const lastProducedRow = scratch.buffer.active.baseY + scratch.buffer.active.cursorY;
    assert.equal(lastProducedRow + 1, count, "scratch produced unexpected physical rows");
    for (let index = 0; index <= lastProducedRow; index++) {
      const line = scratchList.get(index);
      assert.ok(line, `scratch row ${index} missing`);
      prepared.push(line);
    }
    assert.equal(prepared.length, count);
    const lengthBefore = list.length;
    const maxLengthBefore = list.maxLength;
    const ybaseBefore = buffer.ybase;
    const spliceStarted = millis();
    // Exact structural operations from terminalHistoryMaterialize.ts.
    target.clearSelection();
    list.maxLength += prepared.length;
    list.splice(0, 0, ...prepared);
    assert.equal(list.length, lengthBefore + prepared.length, "prepend trimmed an existing row");
    buffer.ybase += prepared.length;
    buffer.ydisp += prepared.length;
    spliceMs = millis() - spliceStarted;
    assert.equal(list.maxLength, maxLengthBefore + count);
    assert.equal(buffer.ybase, ybaseBefore + count);
    target.scrollToTop();
    assert.equal(text(target, 0), `cold-${page}-0`, "new top row mismatch");
    assert.equal(text(target, count - 1), `cold-${page}-${count - 1}`);
    assert.equal(buffer.ydisp, 0, "scrollToTop did not pin the newest cold page to top");
    return { parseMs, spliceMs, rows: prepared.length };
  } finally {
    scratch.dispose();
  }
}

const report = {
  script: "scripts/measure-cold-history-jsdom.mjs",
  kind: "STRUCTURAL_DIAGNOSTIC_ONLY",
  source:
    "xterm 6 CircularList.splice + scratch-row transfer; mirrored from terminalHistoryMaterialize.ts",
  boundary:
    "Node/jsdom real xterm buffer internals only. No production cold-history integration, " +
    "Rust/LZ4/IPC, PTY/SSH, renderer, Chromium, WebView2, GPU or Agent session. " +
    "Memory metrics are Node process readings after optional GC, not release memory gates. " +
    "externalMB already includes arrayBuffersMB; do not add them together.",
  options: { ...options, out: undefined },
  xtermVersion,
  xtermBundleSha256: createHash("sha256").update(xtermBundle).digest("hex"),
  node: process.version,
  forcedGcAvailable: typeof globalThis.gc === "function",
  baseline: null,
  hot: null,
  pages: [],
  summary: null,
  passed: false,
  aborted: false,
};

let term;
try {
  report.baseline = snapshot(0, options.cols);
  const rows = 24;
  const initialCellMb = ((options.hot + rows) * options.cols * 12) / MB;
  if (initialCellMb > options.maxBufferMb) {
    throw new MemoryAbort(
      `hot buffer needs >=${initialCellMb.toFixed(3)} MB of cells; ` +
        `cap is ${options.maxBufferMb} MB`,
    );
  }
  term = new Terminal({ cols: options.cols, rows, scrollback: options.hot });
  const payload = Array.from({ length: options.hot + rows }, (_, index) => `hot-${index}`).join(
    "\r\n",
  );
  const warmStarted = millis();
  await write(term, payload);
  const warmMs = millis() - warmStarted;
  const { buffer, list } = internals(term);
  const initialLength = list.length;
  const initialMaxLength = list.maxLength;
  const firstHot = text(term, 0);
  const lastHot = text(term, initialLength - 1);
  assert.equal(firstHot, "hot-0");
  assert.equal(lastHot, `hot-${options.hot + rows - 1}`);
  assert.equal(initialLength, options.hot + rows);
  report.hot = {
    parsedRows: options.hot + rows,
    warmWriteMs: +warmMs.toFixed(3),
    bufferRows: initialLength,
    maxLength: initialMaxLength,
    ybase: buffer.ybase,
    ydisp: buffer.ydisp,
    memory: snapshot(initialLength, options.cols),
  };

  let totalPrepended = 0;
  for (let page = 1; page <= options.pages; page++) {
    const prepended = await appendScratchRows(
      term,
      page,
      options.pageLines,
      options.cols,
      options.maxBufferMb,
    );
    totalPrepended += prepended.rows;
    const current = internals(term);
    assert.equal(current.list.length, initialLength + totalPrepended);
    assert.equal(current.list.maxLength, initialMaxLength + totalPrepended);
    assert.equal(text(term, totalPrepended), firstHot, "original hot front changed");
    assert.equal(
      text(term, totalPrepended + initialLength - 1),
      lastHot,
      "original hot tail changed",
    );
    report.pages.push({
      page,
      prependedRows: prepended.rows,
      parseMs: +prepended.parseMs.toFixed(3),
      spliceMs: +prepended.spliceMs.toFixed(3),
      bufferRows: current.list.length,
      maxLength: current.list.maxLength,
      ybase: current.buffer.ybase,
      ydisp: current.buffer.ydisp,
      memory: snapshot(current.list.length, options.cols),
    });
  }

  const last = report.pages.at(-1);
  report.summary = {
    pagesCompleted: report.pages.length,
    prependedRows: totalPrepended,
    bufferRows: last?.bufferRows ?? initialLength,
    maxLength: last?.maxLength ?? initialMaxLength,
    maxLengthGrowthRows: (last?.maxLength ?? initialMaxLength) - initialMaxLength,
    liveCellBackingGrowthMB: +((totalPrepended * options.cols * 12) / MB).toFixed(3),
    heapGrowthMB: +(
      (last?.memory.heapUsedMB ?? report.hot.memory.heapUsedMB) - report.hot.memory.heapUsedMB
    ).toFixed(3),
    arrayBuffersGrowthMB: +(
      (last?.memory.arrayBuffersMB ?? report.hot.memory.arrayBuffersMB) -
      report.hot.memory.arrayBuffersMB
    ).toFixed(3),
    maxPageSpliceMs: Math.max(0, ...report.pages.map((item) => item.spliceMs)),
    sampleCount: report.pages.length,
  };
  report.passed = true;
} catch (error) {
  report.aborted = error instanceof MemoryAbort;
  report.error = String(error?.stack ?? error);
  process.exitCode = report.aborted ? 2 : 1;
} finally {
  term?.dispose();
  dom.window.close();
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  // Full per-page evidence belongs in --out; keep terminal output compact.
  console.log(
    JSON.stringify(
      options.out
        ? {
            kind: report.kind,
            passed: report.passed,
            aborted: report.aborted,
            error: report.error,
            hot: report.hot,
            summary: report.summary,
            out: options.out,
          }
        : report,
      null,
      2,
    ),
  );
}
