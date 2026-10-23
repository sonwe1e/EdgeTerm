// App font chain gate on a real production build: App → store
// setPanelFontSize → the App-owned --panel-font-size variable → FilerPanel's
// rowHeight prop and the real CSS row height → the actual virtual rows, at
// the 1100px and minimum desktop widths, with 10 000 synthetic entries proving the
// list stays windowed. Real App, real store, real FilerPanel; the IPC
// boundary is a strict whitelist that records violations (production
// swallows rejections, so the record is the gate).
//
// The same oracle independently confirmed the 12/18px × wide/narrow matrix
// and two isolated mutants (App CSS hardcoded 12px; FilerPanel rowHeight
// hardcoded 26) during the external audit; run a mutant from a disposable
// worktree with EDGE_APP_FONT_ROOT pointing at it to re-prove this script's
// detection.
//
// Boundaries: synthetic entries and the stubbed IPC whitelist prove the
// front-end chain in a real browser; they prove nothing about WebView2, GPU
// renderers or other platforms' engines.
import { build } from "vite";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsArg = process.argv[2] ?? "";
if (!/^[a-z0-9-]+$/.test(resultsArg)) {
  console.error("usage: node scripts/check-app-font-chain.mjs <results-name>");
  process.exit(2);
}
const resultsPath = path.join(repoRoot, ".tmp", "records", "implementation-03", `app-font-${resultsArg}.json`);
try {
  await fs.access(resultsPath);
  console.error(`results file already exists, refusing to overwrite: ${resultsPath}`);
  process.exit(2);
} catch {
  // Fresh name — earlier observations are preserved, never overwritten.
}
// A mutant source tree can be built instead of the working tree (a
// disposable registered worktree under .tmp/mutate), so the negative
// controls run through this same gate.
const subjectRoot = process.env.EDGE_APP_FONT_ROOT
  ? path.resolve(process.env.EDGE_APP_FONT_ROOT)
  : repoRoot;
const outDir = path.join(repoRoot, ".tmp", "app-font-check", `dist-${resultsArg}`);
const config = JSON.parse(await fs.readFile(path.join(subjectRoot, "src-tauri/tauri.conf.json"), "utf8"));
const desktopWindow = config.app.windows.find((window) => (window.label ?? "main") === "main");
assert.ok(desktopWindow, "main desktop window configuration is required");
const minimum = { width: desktopWindow.minWidth, height: desktopWindow.minHeight };
assert.ok(minimum.width > 0 && minimum.height > 0, "desktop minimum window size is required");

// The fixture entry: the real App with the real store, over the whitelist.
const entryId = "\0app-font-chain-fixture.js";
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from ${JSON.stringify(path.join(subjectRoot, "src/App.tsx"))};
import { useStore } from ${JSON.stringify(path.join(subjectRoot, "src/store.ts"))};
import ${JSON.stringify(path.join(subjectRoot, "src/styles.css"))};
const calls = [], unknown = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback(fn) { const id = ++serial; return id; },
  unregisterCallback() {},
  async invoke(command, args) {
    calls.push({ command, args });
    if (command === "plugin:event|listen") return ++serial;
    if (command === "plugin:event|unlisten") return;
    if (["list_profiles", "list_session_groups", "list_system_fonts", "list_port_forwards", "list_file_transfers", "list_recoverable_transfers"].includes(command)) return [];
    if (command === "local_home") return "/synthetic";
    if (command === "local_list") return { path: args.path, entries: Array.from({ length: 10000 }, (_, i) => ({ name: "entry" + i + ".txt", path: args.path + "/entry" + i + ".txt", isDir: false, isSymlink: false, size: i, modified: 1700000000, permissions: null, owner: null, group: null })) };
    if (command === "system_monospace_family") return null;
    if (command === "portable_mode") return false;
    if (command === "local_hostname") return "synthetic-host";
    if (command === "plugin:app|version") return "1.0.0";
    if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
    if (command === "plugin:updater|check") return null;
    if (["set_startup_theme", "set_close_to_tray", "show_main_window", "finish_main_window", "plugin:window|set_title"].includes(command)) return;
    unknown.push({ command, args });
    throw Error("Unexpected app-font fixture IPC: " + command);
  },
};
useStore.setState({ language: "en", gpuRenderer: false, suggestionsEnabled: false, panels: { sessions: false, sender: false, filer: true }, panelDocks: { left: [], right: ["filer"], bottom: [] } });
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(App)));
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
window.__appFontChain = {
  calls,
  unknown,
  async font(size) { flushSync(() => useStore.getState().setPanelFontSize(size)); await frames(); },
  sample() {
    const list = document.querySelector(".filer-list");
    const rows = [...list.querySelectorAll(".filer-entry")];
    const indices = rows.map((row) => Number(/entry(\\d+)\\.txt/.exec(row.querySelector(".row-label").textContent)[1]));
    const pairs = rows.slice(1).map((row, i) => ({
      gap: row.getBoundingClientRect().top - rows[i].getBoundingClientRect().top,
      delta: indices[i + 1] - indices[i],
    })).filter((pair) => pair.delta === 1);
    const app = document.querySelector(".app");
    const dateFont = rows[0]?.querySelector(".filer-col-date");
    const datesFit = rows.every((row) => {
      const date = row.querySelector(".filer-col-date");
      if (!date?.textContent) return true;
      const range = document.createRange();
      range.selectNodeContents(date);
      const text = range.getBoundingClientRect();
      const cell = date.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      return text.width > 0 && text.left >= cell.left - 0.5 &&
        text.right <= cell.right + 0.5 && text.right <= viewport.left + list.clientWidth + 0.5;
    });
    return {
      fontCss: getComputedStyle(app).getPropertyValue("--panel-font-size"),
      rowPitch: pairs.map((pair) => pair.gap),
      entryHeight: rows[0]?.getBoundingClientRect().height ?? null,
      dateFont: dateFont ? getComputedStyle(dateFont).fontSize : null,
      datesFit,
      mountedRows: rows.length,
      listHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    };
  },
};
await document.fonts.ready;
window.__appFontChainReady = true;
`;

const results = [];
const errors = [];
const consoleErrors = [];
const badResources = [];
let browser;
let server;
let browserVersion = "";
let page = null;
let lastPhase = "start";

try {
  const built = await build({
    root: repoRoot,
    configFile: path.join(repoRoot, "vite.config.ts"),
    logLevel: "warn",
    plugins: [{
      name: "app-font-chain-fixture",
      enforce: "pre",
      resolveId(id) { if (id === "app-font-chain-fixture-entry") return entryId; },
      load(id) { if (id === entryId) return entry; },
    }],
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: { input: "app-font-chain-fixture-entry" },
    },
  });
  void built;
  // Emit an index.html beside the entry chunk (the build input was a virtual
  // module, so the html is hand-written from the build output).
  const distFiles = await fs.readdir(outDir, { recursive: true });
  const assets = distFiles.filter((name) => /\.(css|js)$/.test(name));
  const entryChunk = (Array.isArray(built) ? built[0] : built).output
    .find((item) => item.type === "chunk" && item.isEntry)?.fileName
    ?? assets.find((name) => name.endsWith(".js"));
  if (!entryChunk) throw new Error("entry chunk not found in build output");
  const cssLinks = assets.filter((name) => name.endsWith(".css"))
    .map((name) => `<link rel="stylesheet" href="/${name.split(path.sep).join("/")}">`)
    .join("");
  await fs.writeFile(
    path.join(outDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
    `${cssLinks}</head>` +
    `<body><div id="root"></div><script type="module" src="/${entryChunk.split(path.sep).join("/")}"></script></body></html>`,
  );

  const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const target = path.resolve(outDir, `.${name === "/" ? "/index.html" : name}`);
      if (path.relative(outDir, target).startsWith("..")) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await fs.readFile(target);
      res.writeHead(200, { "content-type": mime[path.extname(target)] ?? "application/octet-stream" });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { chromium } = require("playwright");
  const channel = process.env.PERF_BROWSER?.trim() || "chromium";
  browser = await chromium.launch(channel === "chromium" ? { headless: true } : { channel, headless: true });
  browserVersion = browser.version();
  page = await browser.newPage({ locale: "en", viewport: { width: 1100, height: 720 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResources.push({ status: response.status(), url: response.url() });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(
    () => window.__appFontChainReady === true &&
      document.querySelectorAll(".filer-entry").length > 2,
    undefined, { timeout: 20000 },
  );

  const invoke = (method, ...args) => page.evaluate(
    ([method, args]) => window.__appFontChain[method](...args),
    [method, args],
  );
  const wait = (ms) => page.waitForTimeout(ms);
  // The App producer variable, the real row's inner height and date-column
  // font, the consecutive-row pitch and the windowing proof — every layer of
  // the chain, straight from the real list. Sampling layers separately is
  // what catches an App that hardcodes the variable while the store still
  // drives the slot pitch.
  const sample = () => invoke("sample");
  // Collect the FULL wide/narrow × 12/18 matrix: an early throw would hide
  // whether later normal controls still hold. The expectations are the
  // audited literals (12px → 26px pitch / 24px row, 18px → 30px / 28px), not
  // values re-derived from the code under test.
  const failures = [];
  const expectState = async (name, font, pitch, innerHeight, supportedWindow) => {
    const value = await sample();
    const checks = {
      appVariable: value.fontCss === `${font}px`,
      pitch: value.rowPitch.length > 1 &&
        value.rowPitch.every((gap) => Math.abs(gap - pitch) < 0.1),
      innerHeight: value.entryHeight !== null &&
        Math.abs(value.entryHeight - innerHeight) < 0.1,
      dateFont: value.dateFont === `${font - 2}px`,
      // Full dates are required at every supported desktop size. Keep the
      // old 760px probe, but report its clipping separately: Tauri cannot
      // create that window. All font/pitch/virtualization checks still apply.
      ...(supportedWindow ? { datesFit: value.datesFit } : {}),
      windowed: value.mountedRows < 100 && value.mountedRows > 1,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    const passed = failed.length === 0;
    results.push({ name, font, pitch, supportedWindow, passed, failedChecks: failed, sample: value });
    if (!passed) failures.push({ name, failedChecks: failed, sample: value });
  };

  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  for (const [width, height] of [[1100, 720], [minimum.width, minimum.height], [760, 600]]) {
    const supportedWindow = width >= minimum.width && height >= minimum.height;
    await page.setViewportSize({ width, height });
    await invoke("font", 12);
    await wait(200);
    await expectState(`${width}x${height} at font 12`, 12, 26, 24, supportedWindow);
    await invoke("font", 18);
    await wait(200);
    await expectState(`${width}x${height} at font 18`, 18, 30, 28, supportedWindow);
    await page.screenshot({ path: resultsPath.replace(/\.json$/, `-${width}.png`) });
  }
  assert.ok(failures.length === 0,
    `font chain failures: ${JSON.stringify(failures)}`);

  const unknownIpc = await page.evaluate(() => window.__appFontChain.unknown);
  const passedAll = results.every((entry) => entry.passed);
  const boundaryFindings = results.filter((entry) => !entry.supportedWindow && !entry.sample.datesFit)
    .map((entry) => ({ name: entry.name, finding: "date clipping below the desktop minimum", minimum }));
  const report = {
    at: new Date().toISOString(),
    browser: browserVersion,
    channel,
    subjectRoot,
    scope: "Production build (real vite.config). Real App → store.setPanelFontSize → App-owned --panel-font-size → FilerPanel rowHeight + real CSS row height → virtual rows; 10k synthetic entries; consecutive-row pitch within 0.1px of 26/30; full dates required at supported desktop sizes; 760px date clipping reported as a boundary finding; mounted rows < 100 (windowed); unexpected IPC recorded and gated.",
    minimum,
    boundaryFindings,
    passedAll,
    results,
    unknownIpc,
    errors,
    consoleErrors,
    badResources,
  };
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passedAll,
    results: results.map(({ name, passed, supportedWindow }) => ({ name, passed, supportedWindow })),
    boundaryFindings,
    unknownIpc: unknownIpc.length,
    errors: errors.length,
    consoleErrors: consoleErrors.length,
    badResources: badResources.length,
  }));
  if (!passedAll || errors.length > 0 || consoleErrors.length > 0 ||
      badResources.length > 0 || unknownIpc.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  // A failed phase is still evidence: pull whatever the page can still give
  // (unknown IPC, DOM facts) BEFORE the browser closes, then record.
  let unknownIpcLate = null;
  let domFacts = null;
  try {
    unknownIpcLate = await page?.evaluate(() => window.__appFontChain.unknown) ?? null;
  } catch { /* page already gone */ }
  try {
    domFacts = await page?.evaluate(() => ({
      app: !!document.querySelector(".app"),
      list: !!document.querySelector(".filer-list"),
      entries: document.querySelectorAll(".filer-entry").length,
      rows: document.querySelectorAll(".filer-row").length,
      ready: window.__appFontChainReady === true,
    })) ?? null;
  } catch { /* page already gone */ }
  const report = {
    at: new Date().toISOString(),
    browser: browserVersion,
    lastPhase,
    error: String(error),
    results,
    unknownIpc: unknownIpcLate,
    domFacts,
    errors,
    consoleErrors,
    badResources,
  };
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2));
  console.error("app font chain check failed:", String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
}
