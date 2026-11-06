// A1-lite terminal memory/throughput baseline: first measured numbers for
// xterm buffer memory, write throughput and scroll cost (docs/team/STATE.md
// roadmap A1, lite matrix). Non-gating: numbers are recorded for later
// threshold decisions; only errors and fixture self-check failures exit
// nonzero.
//
// Matrix: W1 (plain seq lines) / W3 (agent-style short lines with SGR colors,
// \r spinner redraws and occasional \x1b[K) x rows {10000, 100000} x cols
// {80, 200}, scrollback set to the row count. Per variant it records:
//   - JS heap delta: CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage
//     before Terminal creation vs after the write + GC (V8 heap, not the
//     WebView2/browser process working set).
//   - write throughput: 64KiB chunks through term.write, timed by the write
//     callbacks (the e7da4a7 convention). MB uses 1e6 UTF-16 code units.
//   - scroll p95: rAF interval sampling while alternating scrollLines(-400)
//     and scrollToTop — with no attached renderer this is a JS-side upper
//     bound, not a frame-time measurement.
//   - the ratio of the measured heap delta to the A0 formula lower bound
//     rows*cols*12/1e6 MB; reported, never gated.
//
// The page, served by a minimal in-process node:http server, runs a real
// xterm with no renderer, no link providers and no IPC. A confined sandbox
// forbids the esbuild service pipes a Vite dev server needs and Playwright's
// piped browser transport, so browsers come from an external debug endpoint
// (EDGETERM_MEASURE_CDP or EDGETERM_TERMINAL_MEMORY_CDP) or a loopback spawn
// fallback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const USAGE = "usage: measure-terminal-memory.mjs [--out=PATH]";
const options = {};
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  const joined = /^--(out)=(.+)$/.exec(arg);
  if (joined) {
    options[joined[1]] = joined[2];
    continue;
  }
  const split = /^--(out)$/.exec(arg);
  if (split) {
    const value = rawArgs[++index];
    if (value === undefined) throw new Error(`missing value for ${arg}\n${USAGE}`);
    options[split[1]] = value;
    continue;
  }
  throw new Error(`unknown argument: ${arg}\n${USAGE}`);
}

const ROWS_VIEWPORT = 24;
const ROW_COUNTS = [10000, 100000];
const COLS_OPTIONS = [80, 200];
const WORKLOADS = ["W1", "W3"];
const WRITE_CHUNK = 65536;
const SCROLL_SAMPLES = 64;
const STEP_TIMEOUT_MS = 120000;

/** W1: plain seq-style lines, "number + short suffix", ~8-40 visible chars. */
function buildW1(rows) {
  const parts = [];
  for (let index = 0; index < rows - 1; index++) {
    parts.push(`${index} item ${"x".repeat(3 + (index % 26))}\r\n`);
  }
  parts.push(`DONE ${rows}\r\n`);
  return parts.join("");
}

/**
 * W3: agent-style output — short lines with frequent SGR switches
 * (\x1b[3xm colors and \x1b[1m bold), one \r spinner line (20 same-position
 * redraws) every 10 lines, and occasional \x1b[K. Visible width stays under
 * 30 columns so no line wraps and the buffer line count stays deterministic.
 */
function buildW3(rows) {
  const frames = ["⠋", "⠙", "⠸", "⠼"];
  const parts = [];
  for (let line = 0; line < rows - 1; line++) {
    if (line % 10 === 5) {
      let segment = "";
      for (let tick = 0; tick < 20; tick++) {
        const color = tick % 3 === 0 ? "\u001b[36m" : "\u001b[1m";
        segment += `\r${color}${frames[tick % 4]} tick ${tick}\u001b[0m\u001b[K`;
      }
      parts.push(`${segment}\r\n`);
    } else {
      const clear = line % 7 === 3 ? "\u001b[K" : "";
      const color = `\u001b[${31 + (line % 7)}m`;
      parts.push(
        `${clear}${color}step ${line}\u001b[0m \u001b[1mok\u001b[0m ${"x".repeat(2 + (line % 6))}\r\n`,
      );
    }
  }
  parts.push(`\u001b[32mDONE ${rows}\u001b[0m\r\n`);
  return parts.join("");
}

// Page script: runs inside the served page. String concatenation only — a
// literal "${" would be interpolated by Node; no interpolation is needed.
const html = `<!doctype html><script type="module">
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
let term = null;
window.tm = {};
window.tm.create = (cols, scrollback) => {
  term = new Terminal({ cols: cols, rows: 24, scrollback: scrollback, allowProposedApi: true });
  return true;
};
window.tm.write = async (text) => {
  const start = performance.now();
  let chunks = 0;
  for (let offset = 0; offset < text.length; offset += 65536) {
    await new Promise((resolve) => term.write(text.slice(offset, offset + 65536), resolve));
    chunks += 1;
  }
  return { ms: performance.now() - start, chars: text.length, chunks: chunks };
};
window.tm.validate = (rows, workload) => {
  const buffer = term.buffer.active;
  if (buffer.length !== rows + 1) {
    throw Error('buffer.length ' + buffer.length + ' expected ' + (rows + 1));
  }
  const first = buffer.getLine(0).translateToString(true);
  const last = buffer.getLine(rows - 1).translateToString(true);
  const expectFirst = workload === 'W1' ? '0 item ' : 'step 0 ';
  if (first.slice(0, expectFirst.length) !== expectFirst) {
    throw Error('first row unexpected: ' + JSON.stringify(first));
  }
  if (last !== 'DONE ' + rows) {
    throw Error('last row unexpected: ' + JSON.stringify(last));
  }
  return { bufferRows: buffer.length, firstRow: first, lastRow: last };
};
window.tm.scrollIntervals = (samples) => new Promise((resolve) => {
  const intervals = [];
  let last = performance.now();
  let count = 0;
  const tick = () => {
    const now = performance.now();
    intervals.push(now - last);
    last = now;
    count += 1;
    if (count >= samples) { resolve(intervals); return; }
    if (count % 2 === 1) term.scrollLines(-400); else term.scrollToTop();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
window.tm.dispose = () => { if (term) { term.dispose(); term = null; } };
window.ready = true;
</script>`;

const round4 = (value) => Math.round(value * 1e4) / 1e4;
/** Nearest-rank percentiles. */
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: round4(sorted[0]),
    p50: round4(pick(50)),
    p95: round4(pick(95)),
    p99: round4(pick(99)),
    max: round4(sorted[sorted.length - 1]),
    mean: round4(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  };
};
/** Abandons a stuck page step instead of hanging the whole script. */
const timed = (promise, label) => {
  let timer;
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`page step timed out after ${STEP_TIMEOUT_MS} ms: ${label}`)),
        STEP_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const BROWSER_PATHS = {
  msedge: "Microsoft/Edge/Application/msedge.exe",
  chrome: "Google/Chrome/Application/chrome.exe",
};

function fallbackExecutable(channel) {
  if (channel === "msedge" || channel === "chrome") {
    const roots = [
      process.env["ProgramFiles(x86)"],
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA,
    ];
    for (const root of roots) {
      if (root) {
        const candidate = join(root, BROWSER_PATHS[channel]);
        if (existsSync(candidate)) return candidate;
      }
    }
    throw new Error(`no installed ${channel} executable found for the fallback launch`);
  }
  const managed = chromium.executablePath();
  if (!existsSync(managed)) throw new Error(`no managed browser at ${managed}`);
  return managed;
}

/**
 * Launches the measurement browser: direct Playwright launch, then a loopback
 * spawn fallback for sandboxes that only forbid piped stdio, then an external
 * debug endpoint for sandboxes that forbid spawning browsers at all.
 * browser.close() on a connection only disconnects; external browsers keep
 * running for their owner.
 */
async function launchBrowser(channel, report) {
  const external = process.env.EDGETERM_MEASURE_CDP || process.env.EDGETERM_TERMINAL_MEMORY_CDP;
  if (external) {
    const browser = await chromium.connectOverCDP(external);
    report.browserLaunch = `external-cdp: ${external}`;
    return { browser, cleanup: null };
  }
  try {
    const browser = await chromium.launch({ channel, headless: true });
    report.browserLaunch = "direct";
    return { browser, cleanup: null };
  } catch (directError) {
    let child = null;
    let profileDir = null;
    let spawnError = null;
    try {
      const port = 20000 + Math.floor(Math.random() * 20000);
      profileDir = await mkdtemp(join(os.tmpdir(), "edgeterm-terminal-memory-"));
      child = spawn(
        fallbackExecutable(channel),
        [
          "--headless=new",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      child.on("error", (error) => {
        spawnError = error;
      });
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30000;
      let ready = false;
      while (!ready && !spawnError && Date.now() < deadline) {
        try {
          const response = await fetch(`${endpoint}/json/version`);
          if (response.ok) ready = true;
        } catch {
          // Port not accepting connections yet; keep polling.
        }
        if (!ready && !spawnError) await new Promise((sleep) => setTimeout(sleep, 200));
      }
      if (spawnError) throw new Error(`fallback spawn failed: ${spawnError}`);
      if (!ready) throw new Error(`${endpoint}/json/version never responded`);
      const browser = await chromium.connectOverCDP(endpoint);
      report.browserLaunch = "loopback-cdp-fallback";
      return {
        browser,
        cleanup: async () => {
          child.kill();
          await browser.close().catch(() => {});
          await rm(profileDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch (fallbackError) {
      child?.kill();
      if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `browser launch failed; direct: ${directError}; fallback: ${fallbackError}; in a sandbox ` +
          "that forbids spawning a browser, start Edge yourself with --remote-debugging-port " +
          "and set EDGETERM_MEASURE_CDP=http://127.0.0.1:PORT",
      );
    }
  }
}

const xterm = JSON.parse(await readFile(resolve("node_modules/@xterm/xterm/package.json"), "utf8"));
const xtermBundle = await readFile(resolve("node_modules/@xterm/xterm/lib/xterm.mjs"), "utf8");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "_");
// The default follows the repo's artifacts/performance convention; --out can
// point anywhere writable (a temp directory, for example) where a confined
// sandbox denies writes into ignored directories.
const output = resolve(
  options.out ?? `artifacts/performance/terminal-memory/measure-${stamp}.json`,
);
const report = {
  script: "scripts/measure-terminal-memory.mjs",
  purpose: "A1-lite terminal memory/throughput baseline (docs/team/STATE.md roadmap A1)",
  browser: null,
  browserLaunch: null,
  channel: process.env.PERF_BROWSER || "msedge",
  os: `${os.platform()} ${os.release()}`,
  xtermVersion: xterm.version,
  xtermBundleSha256: createHash("sha256").update(xtermBundle).digest("hex"),
  mode: "in-process HTTP harness; real xterm; no renderer, no link providers, no IPC; heap via CDP",
  boundary:
    "Heap numbers are the page's V8 JS heap (Runtime.getHeapUsage after forced GC), not the " +
    "WebView2/browser process working set. Write throughput covers the xterm parser and buffer " +
    "only, not PTY/network. Scroll intervals are rAF cadence while alternating " +
    "scrollLines(-400)/scrollToTop with no attached renderer — a JS-side upper bound, not frame " +
    "time. MB uses 1e6 UTF-16 code units; escape sequences are included in the written count. " +
    "The A0 formula ratio (rows*cols*12/1e6 MB) is a reported cross-check, never a gate. " +
    "Synthetic workloads; values are machine-specific and ungated.",
  matrix: {
    workloads: {
      W1: "plain seq-style lines, ~8-40 visible chars",
      W3: "agent-style: short SGR-colored lines, \\r spinner (20 redraws) every 10 lines, occasional \\x1b[K",
    },
    rowCounts: ROW_COUNTS,
    cols: COLS_OPTIONS,
    viewportRows: ROWS_VIEWPORT,
    scrollback: "set to the variant row count",
    writeChunkUnits: WRITE_CHUNK,
    scrollSamples: SCROLL_SAMPLES,
  },
  variants: [],
  errors: [],
  passed: false,
};

let browser;
let cleanupBrowser;
let server;
try {
  const send = (res, type, body) => {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };
  server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      send(res, "text/html; charset=utf-8", html);
    } else if (req.url === "/node_modules/@xterm/xterm/lib/xterm.mjs") {
      send(res, "text/javascript; charset=utf-8", xtermBundle);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const launch = await launchBrowser(report.channel, report);
  browser = launch.browser;
  cleanupBrowser = launch.cleanup;
  report.browser = browser.version();
  const page = await browser.newPage();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.goto(base);
  await page.waitForFunction(() => window.ready);
  const cdp = await page.context().newCDPSession(page);
  /** Full GC, a settle, then the isolate's used heap size. */
  const gcHeap = async () => {
    for (let index = 0; index < 2; index++) {
      await cdp.send("HeapProfiler.collectGarbage");
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    const usage = await cdp.send("Runtime.getHeapUsage");
    return usage.usedSize;
  };
  for (const workload of WORKLOADS) {
    for (const rows of ROW_COUNTS) {
      for (const cols of COLS_OPTIONS) {
        const label = `${workload} ${rows}x${cols}`;
        const text = workload === "W1" ? buildW1(rows) : buildW3(rows);
        const baselineBytes = await gcHeap();
        await timed(
          page.evaluate((a) => window.tm.create(a.cols, a.scrollback), { cols, scrollback: rows }),
          `create ${label}`,
        );
        const write = await timed(
          page.evaluate((t) => window.tm.write(t), text),
          `write ${label}`,
        );
        const validation = await timed(
          page.evaluate((a) => window.tm.validate(a.rows, a.workload), { rows, workload }),
          `validate ${label}`,
        );
        const afterBytes = await gcHeap();
        const intervals = await timed(
          page.evaluate((n) => window.tm.scrollIntervals(n), SCROLL_SAMPLES),
          `scroll ${label}`,
        );
        await timed(
          page.evaluate(() => window.tm.dispose()),
          `dispose ${label}`,
        );
        const heapDeltaBytes = afterBytes - baselineBytes;
        const heapDeltaMB = round4(heapDeltaBytes / 1e6);
        const formulaMB = round4((rows * cols * 12) / 1e6);
        report.variants.push({
          workload,
          rows,
          cols,
          scrollback: rows,
          charsWritten: write.chars,
          chunks: write.chunks,
          writeMs: round4(write.ms),
          throughputMBps: round4(write.chars / 1e6 / (write.ms / 1000)),
          validation: "passed",
          bufferRows: validation.bufferRows,
          firstRow: validation.firstRow,
          lastRow: validation.lastRow,
          heapBaselineBytes: baselineBytes,
          heapAfterBytes: afterBytes,
          heapDeltaBytes,
          heapDeltaMB,
          formulaLowerBoundMB: formulaMB,
          heapOverFormula: round4(heapDeltaMB / formulaMB),
          scrollIntervalsMs: stats(intervals),
          scrollIntervalSamplesMs: intervals.map(round4),
        });
      }
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await cleanupBrowser?.();
  await browser?.close().catch(() => {});
  await server?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    flag: options.out ? "w" : "wx",
  });
  const lines = [
    `terminal memory/throughput baseline (${report.channel}, ${report.browser ?? "no browser"}, ` +
      `${report.browserLaunch ?? "not launched"})`,
  ];
  for (const variant of report.variants) {
    lines.push(
      `${variant.workload} ${variant.rows}x${variant.cols}: wrote ${variant.charsWritten} chars in ` +
        `${variant.writeMs} ms (${variant.throughputMBps} MB/s); heap +${variant.heapDeltaMB} MB ` +
        `(formula ${variant.formulaLowerBoundMB} MB, ratio ${variant.heapOverFormula}); ` +
        `scroll p50 ${variant.scrollIntervalsMs.p50} / p95 ${variant.scrollIntervalsMs.p95} ms`,
    );
  }
  if (report.error) lines.push(`ERROR ${report.error.split("\n")[0]}`);
  for (const error of report.errors) lines.push(`PAGEERROR ${error}`);
  lines.push("performance gates: none (A1-lite baseline)");
  lines.push(report.passed ? "PASS baseline recorded" : "FAIL see details above");
  lines.push(`JSON: ${output}`);
  console.log(lines.join("\n"));
}
