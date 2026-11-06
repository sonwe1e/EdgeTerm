// First performance baseline for terminal file-link detection under high
// output (docs/team/STATE.md item C: previously never measured).
//
// xterm's linkifier evaluates a full buffer row through the provider each time
// a moving pointer crosses into a new row; high output with a still pointer
// performs zero evaluations. This script measures that per-row evaluation
// cost on a real xterm inside an isolated headless-Edge page: no attached
// renderer, no mouse pipeline, no IPC, no open-path IO. The page, the xterm
// bundle and the provider (transpiled in-process with the repo's TypeScript)
// are served by a minimal node:http server — a confined sandbox forbids the
// esbuild service pipes a Vite dev server spawns, and this harness needs no
// transforms at measure time. The provider is registered through the same
// term.registerLinkProvider path as src/terminal.ts, wrapped to time every
// provideLinks call; sweeps emulate the pointer crossing the viewport row by
// row.
//
// There are deliberately no performance gates yet: numbers are recorded for
// later threshold decisions. Only errors, fixture self-check failures or a
// per-call p95 sanity tripwire (> 50 ms) exit nonzero.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import ts from "typescript";

const USAGE = "usage: measure-file-links.mjs [--chars=N] [--rows=N] [--out=PATH]";
const options = {};
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  const joined = /^--(chars|rows|out)=(.+)$/.exec(arg);
  if (joined) {
    options[joined[1]] = joined[2];
    continue;
  }
  const split = /^--(chars|rows|out)$/.exec(arg);
  if (split) {
    const value = rawArgs[++index];
    if (value === undefined) throw new Error(`missing value for ${arg}\n${USAGE}`);
    options[split[1]] = value;
    continue;
  }
  throw new Error(`unknown argument: ${arg}\n${USAGE}`);
}
const targetChars = Number(options.chars ?? 800000);
const lineBudget = options.rows === undefined ? null : Number(options.rows);
assert.ok(
  Number.isInteger(targetChars) && targetChars >= 10000,
  `--chars must be an integer >= 10000\n${USAGE}`,
);
assert.ok(
  lineBudget === null || (Number.isInteger(lineBudget) && lineBudget >= 100),
  `--rows must be an integer >= 100\n${USAGE}`,
);

const ROWS = 24;
const SCROLLBACK = 10000;
const WIDTHS = [80, 200];
const CYCLE = 6;
const SWEEPS = 12;
const SWEEP_WARMUPS = 2;
const CHUNK_ROWS = 500;
const TRIPWIRE_MS = 50;
const STEP_TIMEOUT_MS = 60000;

const pad = (value, width) => String(value).padStart(width, "0");

/**
 * One workload line. Six categories cycle deterministically so any window of
 * the buffer holds the same mix; wide terminals get wider lines because
 * translateToString and the cell walk both cost actual content, not cols.
 */
function workloadLine(cols, index) {
  const stamp = `${pad((index * 7) % 24, 2)}:${pad((index * 13) % 60, 2)}:${pad((index * 29) % 60, 2)}`;
  switch (index % CYCLE) {
    case 0: {
      // Plain log line: no linkable token, only regex rejection cost.
      const log =
        `[${stamp}] INFO worker-${index % 8} ok qd=${index % 97} ` +
        `lat=${(index % 37) + 0.4}ms region=cn-${index % 9} shard=${index % 16}`;
      if (cols < 200) return log;
      return (
        log +
        ` session=s-${pad(index % 1000, 4)} user=u-${pad(index % 500, 3)}` +
        ` op=read replicas=${index % 5} ack=true lag_ms=${index % 250} backoff=none`
      );
    }
    case 1: {
      // Python traceback row: the TRACEBACK branch with a quoted absolute path.
      const line = 1 + (index % 9000);
      if (cols < 200) {
        return `  File "/srv/app/src/models/train_${pad(index % 40, 2)}.py", line ${line}, in forward_pass`;
      }
      return (
        `  File "/srv/app/src/models/experiments/run_${pad(index % 40, 2)}/checkpoints/` +
        `epoch_${index % 20}/train_${pad(index % 40, 2)}.py", line ${line}, ` +
        `in forward_pass (step=${index % 10000}, loss=${(index % 700) / 100})`
      );
    }
    case 2: {
      // grep-style references: path:line and path:line:column.
      if (cols < 200) {
        return `src/app/module_${pad(index % 20, 2)}.py:${1 + (index % 500)}: def handle_batch(items):`;
      }
      return (
        `/srv/app/src/main.py:${100 + (index % 800)}:8: keyword=alpha found here; ` +
        `../lib/util.py:${1 + (index % 300)}:1: secondary hit (context=strict)`
      );
    }
    case 3: {
      // Quoted absolute paths: the QUOTED branch keeps spaces linkable.
      const version = index % 9;
      const tenant = index % 300;
      if (cols < 200) {
        return `config "/srv/app/config/envs/production_v${version}.json" loaded for tenant ${tenant}`;
      }
      return (
        `config "/srv/app/config/envs/production_v${version}.json" merged with ` +
        `"/srv/app/config/overrides/tenant_${tenant}.json" for tenant ${tenant} in 3ms`
      );
    }
    case 4: {
      // A token at (and just over) the 1024 path limit. Both variants pay the
      // full token scan, then wrap across many rows, where no single row's
      // fragment can produce a valid unclipped link.
      const total = index % 12 === 4 ? 1036 : 1024;
      const filler = total - "/data/pack_0000/".length - "/weights.bin".length;
      return (
        `pathological token follows: /data/pack_${pad(index % 100, 4)}/` +
        `${"x".repeat(filler)}/weights.bin end`
      );
    }
    default:
      // URLs and prose: rejected shapes (://, host:port-like) that still scan.
      return (
        `see https://example.com/docs/run-guide#section-${index % 50} and ` +
        `http://cdn.example.net/assets/logo.svg before retry ${index % 30}`
      );
  }
}

/** Builds the full stream: workload lines padded to a cycle boundary, then a
 * fixed validation block whose rows must link (or not) in known ways. */
function buildWorkload(cols) {
  const lines = [];
  let chars = 0;
  const add = (line) => {
    lines.push(line);
    chars += line.length + 2;
  };
  for (let index = 0; ; index++) {
    const done = lineBudget === null ? chars >= targetChars : lines.length >= lineBudget;
    if (done) break;
    add(workloadLine(cols, index));
  }
  while (lines.length % CYCLE !== 0) add(workloadLine(cols, lines.length));
  const validation = [
    "EDGETERM-VALIDATE-START",
    '  File "/srv/validate/traceback.py", line 42, in <module>',
    "/srv/validate/grep.py:7: fixed match",
    "EDGETERM-VALIDATE plain row without references",
    "EDGETERM-VALIDATE-END",
  ];
  const text = [...lines, ...validation].join("\r\n") + "\r\n";
  return {
    text,
    charsWritten: text.length,
    logicalLines: lines.length,
    sampleLines: lines
      .slice(0, CYCLE)
      .map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line)),
  };
}

// Page script: runs inside the served page. Its own code must use string
// concatenation only — a literal "${" here would be interpolated by Node; the
// two interpolations below intentionally inject Node-side constants.
const html = `<!doctype html><script type="module">
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { createFileLinkProvider } from '/__terminalFileLinks.js';
const state = { term: null, real: null, wrapped: null, samples: [], sweeps: 0, recording: false };
window.fl = {};
window.fl.setup = async (cols, text) => {
  state.term = new Terminal({ cols: cols, rows: ${ROWS}, scrollback: ${SCROLLBACK}, allowProposedApi: true });
  const start = performance.now();
  for (let offset = 0; offset < text.length; offset += 65536) {
    await new Promise((resolve) => state.term.write(text.slice(offset, offset + 65536), resolve));
  }
  const writeMs = performance.now() - start;
  state.real = createFileLinkProvider({
    terminal: state.term,
    getCwdForLine: () => null,
    openLink: () => {},
    isMouseTracking: () => false,
  });
  state.samples = [];
  state.sweeps = 0;
  state.recording = false;
  state.wrapped = {
    provideLinks: (bufferLineNumber, callback) => {
      const start = performance.now();
      state.real.provideLinks(bufferLineNumber, (links) => {
        if (state.recording) {
          state.samples.push({ ms: performance.now() - start, links: links ? links.length : 0 });
        }
        callback(links);
      });
    },
  };
  // Same integration path as src/terminal.ts: registerLinkProvider(provider).
  state.term.registerLinkProvider(state.wrapped);
  return { writeMs: writeMs, bufferRows: state.term.buffer.active.length };
};
window.fl.validate = async () => {
  const buffer = state.term.buffer.active;
  const linksOf = (row) => new Promise((resolve) => state.real.provideLinks(row, resolve));
  let anchor = -1;
  for (let row = buffer.length; row > buffer.length - 12 && row > 0; row--) {
    if (buffer.getLine(row - 1).translateToString(true).includes('EDGETERM-VALIDATE-START')) {
      anchor = row;
      break;
    }
  }
  if (anchor < 1 || anchor + 4 > buffer.length) throw Error('validation anchor row not found');
  const traceback = await linksOf(anchor + 1);
  const tbText = traceback ? traceback.map((link) => link.text).join(',') : 'none';
  if (!traceback || traceback.length !== 1 || traceback[0].text !== '/srv/validate/traceback.py') {
    throw Error('traceback row not linked as expected: ' + tbText);
  }
  const grep = await linksOf(anchor + 2);
  const grepText = grep ? grep.map((link) => link.text).join(',') : 'none';
  if (!grep || grep.length !== 1 || grep[0].text !== '/srv/validate/grep.py:7') {
    throw Error('path:line row not linked as expected: ' + grepText);
  }
  const plain = await linksOf(anchor + 3);
  if (plain !== undefined) throw Error('plain row unexpectedly linked');
  return 'passed';
};
window.fl.sweep = (recorded) => {
  const buffer = state.term.buffer.active;
  const rows = [];
  for (let k = 0; k < state.term.rows; k++) rows.push(buffer.length - state.term.rows + 1 + k);
  if (state.sweeps % 2 === 1) rows.reverse();
  state.sweeps += 1;
  const start = performance.now();
  state.recording = recorded;
  for (const row of rows) state.wrapped.provideLinks(row, () => {});
  state.recording = false;
  return performance.now() - start;
};
window.fl.chunk = (startRow, count) => {
  const buffer = state.term.buffer.active;
  const end = Math.min(startRow + count - 1, buffer.length);
  const start = performance.now();
  for (let row = startRow; row <= end; row++) state.real.provideLinks(row, () => {});
  return { endRow: end, ms: performance.now() - start };
};
window.fl.resetSamples = () => { state.samples = []; };
window.fl.takeSamples = () => { const samples = state.samples; state.samples = []; return samples; };
window.fl.dispose = () => {
  if (state.term) { state.term.dispose(); state.term = null; }
};
window.ready = true;
</script>`;

const round4 = (value) => Math.round(value * 1e4) / 1e4;
/** Nearest-rank percentiles; the mean cross-checks the quantized clock. */
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
 * Launches the measurement browser. Playwright's direct launch talks to the
 * browser over piped stdio, which confined sandboxes forbid; when that fails
 * the script spawns an installed browser with a loopback debug port instead
 * and connects over a WebSocket, which needs no pipes. The fallback kills its
 * own browser process and profile directory through the returned cleanup.
 */
async function launchBrowser(channel, report) {
  // Escape hatch for sandboxes that forbid spawning a browser: connect to one
  // started outside (msedge --headless=new --remote-debugging-port=PORT).
  // browser.close() only disconnects this connection and its contexts; the
  // externally started browser process keeps running for its owner.
  const external = process.env.EDGETERM_FILE_LINKS_CDP;
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
      profileDir = await mkdtemp(join(os.tmpdir(), "edgeterm-file-links-"));
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
          "and set EDGETERM_FILE_LINKS_CDP=http://127.0.0.1:PORT",
      );
    }
  }
}

const source = await readFile(resolve("src/terminalFileLinks.ts"), "utf8");
const xterm = JSON.parse(await readFile(resolve("node_modules/@xterm/xterm/package.json"), "utf8"));
// In-process transpile: typescript's transpileModule spawns nothing, while a
// Vite dev server would need the esbuild service process (piped stdio).
const providerJs = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const xtermBundle = await readFile(resolve("node_modules/@xterm/xterm/lib/xterm.mjs"), "utf8");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "_");
// The default follows the repo's artifacts/performance convention; --out can
// point anywhere writable (a temp directory, for example) where a confined
// sandbox denies writes into ignored directories.
const output = resolve(options.out ?? `artifacts/performance/file-links/measure-${stamp}.json`);
const report = {
  script: "scripts/measure-file-links.mjs",
  purpose: "first file-link provider baseline under high output (docs/team/STATE.md item C)",
  browser: null,
  browserLaunch: null,
  channel: process.env.PERF_BROWSER || "msedge",
  os: `${os.platform()} ${os.release()}`,
  xtermVersion: xterm.version,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  mode: "in-process HTTP harness; real xterm; file-link provider only; no build tooling, renderer, mouse pipeline or IPC",
  boundary:
    "Provider evaluation cost per buffer row: what the xterm linkifier pays each time a moving pointer " +
    "crosses into a new row (high output with a still pointer costs zero evaluations). The linkifier's " +
    "own row caching and dispose, renderer hit-testing, hover underlining, click/open IO and native " +
    "WebView2 are not measured. performance.now() is quantized (~0.1 ms) on a non-isolated page, so " +
    "per-call percentiles are coarse; sweep totals and full-buffer means are the accurate cross-check.",
  workload: {
    targetChars,
    lineBudget,
    rows: ROWS,
    scrollback: SCROLLBACK,
    widths: WIDTHS,
    cycleLines: CYCLE,
    categories: [
      "plain log",
      "python traceback",
      "path:line",
      "quoted path",
      "near-limit long token",
      "url prose",
    ],
    validation: "traceback and path:line rows must link; a plain row must not",
  },
  sampling: { sweeps: SWEEPS, sweepWarmups: SWEEP_WARMUPS, rowsPerSweep: ROWS, minSamples: 200 },
  tripwireMs: TRIPWIRE_MS,
  gated: false,
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
    } else if (req.url === "/__terminalFileLinks.js") {
      send(res, "text/javascript; charset=utf-8", providerJs);
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
  for (const cols of WIDTHS) {
    const workload = buildWorkload(cols);
    const setup = await timed(
      page.evaluate((a) => window.fl.setup(a.cols, a.text), { cols, text: workload.text }),
      `setup ${cols}`,
    );
    await timed(
      page.evaluate(() => window.fl.validate()),
      `validate ${cols}`,
    );
    for (let index = 0; index < SWEEP_WARMUPS; index++) {
      await timed(
        page.evaluate(() => window.fl.sweep(false)),
        `warmup ${cols}`,
      );
    }
    await timed(
      page.evaluate(() => window.fl.resetSamples()),
      `reset ${cols}`,
    );
    const sweepTotals = [];
    for (let index = 0; index < SWEEPS; index++) {
      sweepTotals.push(
        await timed(
          page.evaluate(() => window.fl.sweep(true)),
          `sweep ${cols}`,
        ),
      );
    }
    const samples = await timed(
      page.evaluate(() => window.fl.takeSamples()),
      `samples ${cols}`,
    );
    assert.ok(samples.length >= 200, `expected >= 200 samples, got ${samples.length}`);
    let bufferMs = 0;
    let row = 1;
    while (row <= setup.bufferRows) {
      const chunk = await timed(
        page.evaluate((a) => window.fl.chunk(a.start, a.count), { start: row, count: CHUNK_ROWS }),
        `chunk ${cols}`,
      );
      bufferMs += chunk.ms;
      row = chunk.endRow + 1;
    }
    await timed(
      page.evaluate(() => window.fl.dispose()),
      `dispose ${cols}`,
    );
    const callsWithLinks = samples.filter((sample) => sample.links > 0).length;
    assert.ok(callsWithLinks > 0, "no sweep call produced links; the fixture regressed");
    report.variants.push({
      cols,
      charsWritten: workload.charsWritten,
      logicalLines: workload.logicalLines,
      sampleLines: workload.sampleLines,
      bufferRows: setup.bufferRows,
      writeMs: round4(setup.writeMs),
      validation: "passed",
      sweep: {
        sweeps: SWEEPS,
        rowsPerSweep: ROWS,
        calls: samples.length,
        callsWithLinks,
        linksReturned: samples.reduce((total, sample) => total + sample.links, 0),
        perCallMs: stats(samples.map((sample) => sample.ms)),
        perSweepMs: stats(sweepTotals),
        callSamplesMs: samples.map((sample) => round4(sample.ms)),
        sweepTotalsMs: sweepTotals.map(round4),
      },
      fullBuffer: {
        rows: setup.bufferRows,
        totalMs: round4(bufferMs),
        meanMsPerRow: round4(bufferMs / setup.bufferRows),
      },
    });
  }
  assert.deepEqual(report.errors, []);
  const breaches = report.variants.filter((variant) => variant.sweep.perCallMs.p95 > TRIPWIRE_MS);
  if (breaches.length > 0) {
    report.tripwireBreaches = breaches.map(
      (variant) =>
        `${variant.cols} cols: per-call p95 ${variant.sweep.perCallMs.p95} ms > ${TRIPWIRE_MS} ms`,
    );
    process.exitCode = 1;
  } else {
    report.passed = true;
  }
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
    `file-link provider baseline (${report.channel}, ${report.browser ?? "no browser"}, ` +
      `${report.browserLaunch ?? "not launched"})`,
  ];
  for (const variant of report.variants) {
    lines.push(
      `${variant.cols}x${ROWS}: ${variant.charsWritten} chars, ${variant.logicalLines} lines -> ` +
        `${variant.bufferRows} buffer rows (write ${variant.writeMs} ms, validation ${variant.validation})`,
    );
    lines.push(
      `  pointer sweep: ${variant.sweep.calls} provideLinks calls ` +
        `(${variant.sweep.sweeps} sweeps x ${variant.sweep.rowsPerSweep} rows), links on ` +
        `${variant.sweep.callsWithLinks} calls (${variant.sweep.linksReturned} links)`,
    );
    lines.push(
      `    per call  p50 ${variant.sweep.perCallMs.p50} / p95 ${variant.sweep.perCallMs.p95} / ` +
        `p99 ${variant.sweep.perCallMs.p99} ms (min ${variant.sweep.perCallMs.min}, ` +
        `max ${variant.sweep.perCallMs.max}, mean ${variant.sweep.perCallMs.mean})`,
    );
    lines.push(
      `    per sweep p50 ${variant.sweep.perSweepMs.p50} / p95 ${variant.sweep.perSweepMs.p95} / ` +
        `p99 ${variant.sweep.perSweepMs.p99} ms`,
    );
    lines.push(
      `  full buffer: ${variant.fullBuffer.rows} rows in ${variant.fullBuffer.totalMs} ms ` +
        `(${variant.fullBuffer.meanMsPerRow} ms/row)`,
    );
  }
  if (report.tripwireBreaches)
    lines.push(...report.tripwireBreaches.map((text) => `TRIPWIRE ${text}`));
  if (report.error) lines.push(`ERROR ${report.error.split("\n")[0]}`);
  for (const error of report.errors) lines.push(`PAGEERROR ${error}`);
  lines.push(
    `tripwire: per-call p95 <= ${TRIPWIRE_MS} ms; performance gates: none (first baseline)`,
  );
  lines.push(report.passed ? "PASS baseline recorded" : "FAIL see details above");
  lines.push(`JSON: ${output}`);
  console.log(lines.join("\n"));
}
