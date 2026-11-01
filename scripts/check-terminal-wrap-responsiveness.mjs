// Exercise the production terminal write hooks with real xterm in an isolated
// browser. The watchdog runs outside the page, so an infinite loop fails the
// check instead of freezing the test runner. No native sessions or user data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = resolve(process.env.EDGETERM_WRAP_ROOT || ".");
const output = resolve(process.argv[2] || "artifacts/terminal-wrap/responsiveness.json");
const html = String.raw`<!doctype html><script type="module">
import { TerminalController } from '/src/terminal.ts';
window.beats = 0;
setInterval(() => window.beats++, 25);
window.run = async ({scrollback, alternate}) => {
  const controller = new TerminalController('wrap-fixture', {
    onData() {}, onResize() {}, onStatus() {}, onCommand() {},
    onCommandState() {}, suggest: () => [], forgetSuggestion() {},
  }, 13, scrollback);
  window.controller = controller;
  controller.setVisible(true);
  const write = text => new Promise(resolve =>
    controller.write(new TextEncoder().encode(text), resolve));
  if (alternate) await write('\x1b[?1049h');
  controller.term.resize(8, 3);
  await write('abcdefgh'.repeat(10));
  // Observe the actual buffer after the application's write/scroll hooks run.
  await new Promise(resolve => setTimeout(resolve, 100));
  const buffer = controller.term.buffer.active;
  const wrapped = Array.from({length: buffer.length}, (_, row) =>
    buffer.getLine(row).isWrapped);
  await write('\r\nWRAP-OK\r\n');
  await new Promise(resolve => setTimeout(resolve, 100));
  const lines = Array.from({length: buffer.length}, (_, row) =>
    buffer.getLine(row).translateToString(true));
  controller.dispose();
  return {wrapped, lines, beats: window.beats};
};
window.ready = true;
</script>`;

async function deadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Renderer did not answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "terminal-wrap-responsiveness",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__wrap_probe") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
});
const report = {
  sourceSha256: createHash("sha256")
    .update(await readFile(resolve(root, "src/terminalSemanticRenderer.ts")))
    .digest("hex"),
  os: `${os.platform()} ${os.release()}`,
  mode: "Vite development; real TerminalController and xterm; no renderer attached or IPC",
  workload: { cols: 8, rows: 3, text: "abcdefgh repeated 10 times without a newline" },
  boundary: "Browser JavaScript liveness only; not native WebView2, GPU or server validation",
  cases: [],
  errors: [],
};
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.PERF_BROWSER || "msedge",
    headless: true,
  });
  report.browser = browser.version();
  for (const scenario of [
    { scrollback: 0, alternate: false },
    { scrollback: 2, alternate: false },
    { scrollback: 2, alternate: true },
  ]) {
    const page = await browser.newPage();
    page.on("pageerror", (error) => report.errors.push(String(error)));
    await page.goto(`${server.resolvedUrls.local[0]}__wrap_probe`);
    await page.waitForFunction(() => window.ready);
    const result = await deadline(
      page.evaluate((args) => window.run(args), scenario),
      3000,
    );
    assert.equal(result.wrapped.length, scenario.alternate ? 3 : 3 + scenario.scrollback);
    assert.ok(result.wrapped.every(Boolean), "Every retained row must be a soft wrap");
    assert.ok(result.lines.includes("WRAP-OK"), "Subsequent output must still parse");
    assert.ok(result.beats > 0, "The page event loop must still run");
    report.cases.push({ ...scenario, ...result });
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), server.close()]);
  report.cleanupErrors = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  if (report.cleanupErrors.length) {
    report.passed = false;
    process.exitCode = 1;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
