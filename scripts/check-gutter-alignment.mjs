// Gutter-alignment contract on a real production build: the terminal's
// line-number gutter must keep the xterm row pitch through the component's
// hide → resize → show chain and store font changes, with no extra fit call
// to mask a stale measurement. Real SessionPane/TerminalController via the
// production ensureController factory (registered before any component
// borrows it), real DOM renderer (public renderer preference), real output
// through the public write path, strict IPC whitelist whose violations are
// recorded and gated (production swallows the rejections). The Vitest
// dev-mode contracts cannot reproduce the production build's timing; this
// script is the build-artifact oracle.
//
// Boundaries: synthetic lines and the stubbed IPC whitelist prove the
// front-end measurement timing in a real browser; they prove nothing about
// PTY round-trips, GPU renderers, WebView2 or other platforms' engines.
import { build } from "vite";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A mutant source tree can be checked instead of the working tree: point
// EDGE_GUTTER_ROOT at a disposable registered worktree (under .tmp/mutate,
// like the app-font gate's EDGE_APP_FONT_ROOT). Everything — fixture html,
// fixture module, sources — then comes from that tree.
const repoBase = process.env.EDGE_GUTTER_ROOT
  ? path.resolve(process.env.EDGE_GUTTER_ROOT)
  : repoRoot;
if (process.env.EDGE_GUTTER_ROOT) {
  const relative = path.relative(path.resolve(repoRoot, ".tmp", "mutate"), repoBase);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error("EDGE_GUTTER_ROOT must point inside .tmp/mutate (a disposable worktree)");
    process.exit(2);
  }
}
const resultsArg = process.argv[2] ?? "";
if (!/^[a-z0-9-]+$/.test(resultsArg)) {
  console.error("usage: node scripts/check-gutter-alignment.mjs <results-name>");
  process.exit(2);
}
const resultsPath = path.join(repoRoot, ".tmp", "records", "implementation-03", `gutter-check-${resultsArg}.json`);
try {
  await fs.access(resultsPath);
  console.error(`results file already exists, refusing to overwrite: ${resultsPath}`);
  process.exit(2);
} catch {
  // Fresh name — the earlier observations are preserved, never overwritten.
}
// One compiled build per results name, nothing emptied afterwards: earlier
// compiled evidence stays on disk for audit.
const outDir = path.join(repoRoot, ".tmp", "gutter-check", `dist-${resultsArg}`);

await build({
  root: repoBase,
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: path.join(repoBase, "scripts", "gutter-check.html") },
  },
});
// The html keeps its directory position relative to the root (scripts/…);
// find wherever the build actually put it.
const htmlPath = await (async () => {
  const candidates = ["scripts/gutter-check.html", "gutter-check.html"];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(outDir, candidate));
      return candidate;
    } catch {
      // try the next location
    }
  }
  throw new Error(`built fixture html not found under ${outDir}`);
})();

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const server = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.resolve(outDir, `.${name}`);
    if (path.relative(outDir, file).startsWith("..")) {
      res.writeHead(403).end();
      return;
    }
    const bytes = await fs.readFile(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const { chromium, webkit } = require("playwright");
const engine = process.env.PERF_ENGINE?.trim() || "chromium";
const channel = process.env.PERF_BROWSER?.trim() || "chromium";
let browser;
const errors = [];
const badResources = [];
const results = [];
let browserVersion = "";
try {
  browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch(channel === "chromium" ? { headless: true } : { channel, headless: true });
  browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) badResources.push({ status: response.status(), url: response.url() });
  });
  await page.addInitScript(() => {
    let serial = 0;
    window.__gutterCheckUnexpectedIpc = [];
    const allowed = new Set([
      "resize_session",
      "write_session_bytes",
      "plugin:event|listen",
      "plugin:event|unlisten",
    ]);
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++serial,
      unregisterCallback: () => {},
      invoke: async (command) => {
        if (allowed.has(command)) return undefined;
        // Production code swallows the rejection; the record is the gate.
        window.__gutterCheckUnexpectedIpc.push(String(command));
        throw new Error(`Unexpected gutter-check IPC: ${command}`);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/${htmlPath.split("\\").join("/")}`);
  await page.waitForFunction(() => window.__gutterCheckReady === true, undefined, { timeout: 15000 });

  // Every step gets a bounded diagnostic timeout so a hung fixture call
  // fails fast with its phase name instead of stalling the run.
  const phase = (name) => console.error(`[phase] ${name}`);
  const withTimeout = (name, promise, ms = 20000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`phase "${name}" timed out after ${ms}ms`)), ms,
    )),
  ]);
  const aligned = (sample) =>
    Number.isFinite(sample.gutterPitch) && Number.isFinite(sample.textPitch) &&
    Math.abs(sample.gutterPitch - sample.textPitch) < 0.1 &&
    sample.maxRowOffset !== null && sample.maxRowOffset < 0.5;
  // The real fit relation from the live geometry: the screen fills the host
  // up to the terminal's own scrollbar reservation and is maximal at the
  // cell grid. This catches a fit that never applied (WebKit's hidden-first
  // mount kept 80x24 with a screen taller than the host) without any
  // arbitrary column-count threshold.
  const fitApplied = (sample) => {
    if (sample.cols === null || sample.rows === null ||
        sample.screenWidth === null || sample.screenHeight === null ||
        sample.hostWidth === null || sample.hostHeight === null) return false;
    const cellW = sample.screenWidth / sample.cols;
    const cellH = sample.screenHeight / sample.rows;
    if (!(cellW > 0 && cellH > 0)) return false;
    const availableW = sample.hostWidth - (sample.reservedScrollbar ?? 0);
    return sample.screenWidth <= sample.hostWidth + 1 &&
      sample.screenWidth + 2 * cellW > availableW &&
      sample.screenHeight <= sample.hostHeight + 1 &&
      sample.screenHeight + 2 * cellH > sample.hostHeight;
  };

  const record = (name, passed, sample) => {
    results.push({ name, expectPass: true, passed, sample });
  };
  const wait = (ms) => page.waitForTimeout(ms);
  const invoke = (method, ...args) => withTimeout(`invoke ${method}`, page.evaluate(
    ([method, args]) => window.__gutterCheck[method](...args),
    [method, args],
  ));
  const evaluate = (fn) => withTimeout("evaluate", page.evaluate(fn));

  // Normal control 1: a real factory session shown directly stays aligned.
  phase("direct mount");
  await withTimeout("createDirect", invoke("createDirect", 640, 400, 199));
  await wait(250);
  const directA = await evaluate(() => window.__gutterCheck.sample());
  record("direct visible mount is aligned (normal control)",
    aligned(directA) && fitApplied(directA), directA);

  // Normal control 2: a visible direct resize really fits — the public
  // scheduleFit entry runs, and the dimensions must actually change.
  phase("direct resize");
  await invoke("resizePane", 780, 480);
  await invoke("scheduleFit");
  await wait(250);
  const directB = await evaluate(() => window.__gutterCheck.sample());
  record("direct visible resize is aligned (normal control)",
    aligned(directB) && fitApplied(directB) && directB.cols !== directA.cols,
    directB);

  // The component case: the production factory registers the session first,
  // the pane mounts hidden, real output lands in the buffer, then it shows.
  phase("session create");
  await invoke("disposeAll");
  await wait(50);
  await invoke("sessionCreate");
  await invoke("sessionMount", false, 640, 400);
  await wait(150);
  phase("write 300 lines");
  const written = await invoke("writeLines", 300);
  if (written !== 300) throw new Error(`buffer write produced ${written} lines, expected 300`);

  // First show: the fit must actually apply (WebKit kept 80x24 with a screen
  // taller than the host) and the gutter must be aligned at the settled state.
  phase("first show");
  await invoke("sessionMount", true, 640, 400);
  await wait(250);
  const firstShow = await evaluate(() => window.__gutterCheck.sample());
  record("first show after hidden mount fits and is aligned",
    aligned(firstShow) && fitApplied(firstShow), firstShow);

  // Hidden → resize → show: the misaligned case.
  phase("hidden resize show");
  await invoke("sessionMount", false, 900, 560);
  await wait(150);
  await invoke("sessionMount", true, 900, 560);
  await wait(250);
  const resizedShow = await evaluate(() => window.__gutterCheck.sample());
  record("show after hidden resize is aligned",
    aligned(resizedShow) && fitApplied(resizedShow) &&
    resizedShow.rows !== null && resizedShow.rows > firstShow.rows,
    resizedShow);

  // Hidden → font increase → show: the new font must apply (text pitch up,
  // row count down) and stay aligned with the gutter.
  phase("hidden font show");
  await invoke("sessionMount", false, 900, 560);
  await invoke("setFont", 24);
  await wait(250);
  await invoke("sessionMount", true, 900, 560);
  await wait(250);
  const fontShow = await evaluate(() => window.__gutterCheck.sample());
  record("show after hidden font change applies the font and is aligned",
    aligned(fontShow) && fitApplied(fontShow) &&
    fontShow.textPitch !== null && fontShow.textPitch > resizedShow.textPitch &&
    fontShow.rows !== null && fontShow.rows < resizedShow.rows,
    fontShow);

  const unexpectedIpc = await evaluate(() => window.__gutterCheckUnexpectedIpc);
  const alignedAll = results.every((entry) => entry.passed);
  await page.screenshot({
    path: path.join(repoRoot, ".tmp", "records", "implementation-03", `gutter-check-${resultsArg}.png`),
  });
  const report = {
    at: new Date().toISOString(),
    browser: browserVersion,
    channel,
    engine,
    subjectRoot: repoBase,
    scope: "Production build (vite build with the real vite.config defines). Real SessionPane/TerminalController via ensureController registered before the component borrows it, DOM renderer through the public preference, 300 real buffer lines written through the xterm parser (term.write), store font chain. Gutter/text pitch must agree within 0.1px and rows within 0.5px at every settled state; fits must actually apply (screen vs host geometry with the terminal's own scrollbar reservation); unexpected IPC is a recorded gate; no extra fit call participates.",
    alignedAll,
    results,
    unexpectedIpc,
    errors,
    badResources,
  };
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    alignedAll,
    results: results.map(({ name, passed }) => ({ name, passed })),
    unexpectedIpc: unexpectedIpc.length,
    errors: errors.length,
    badResources: badResources.length,
  }));
  if (!alignedAll || errors.length > 0 || badResources.length > 0 || unexpectedIpc.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  // A failed phase is still evidence: record it under the same unique name
  // and fail the run instead of leaving nothing behind.
  results.push({ name: "run error", expectPass: true, passed: false, error: String(error) });
  const report = {
    at: new Date().toISOString(),
    browser: browserVersion,
    channel,
    error: String(error),
    alignedAll: false,
    results,
    unexpectedIpc: [],
    errors,
    badResources,
  };
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2));
  console.error("gutter check failed:", String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
