// Isolated real-browser regression: no Tauri sessions or user terminal data.
// An external watchdog can close a renderer stuck inside RegExp.exec.
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

const output = resolve(process.argv[2] || "artifacts/ui-search/responsiveness.json");
const html = `<!doctype html><div id="terminal" style="width:900px;height:400px"></div>
<script type="module">
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { TerminalFind } from '/src/terminalFind.ts';
const term = new Terminal({allowProposedApi:true,cols:80,rows:24,scrollback:20000});
term.open(document.getElementById('terminal'));
const find = new TerminalFind(term,{match:'#623315',activeMatch:'#9e6a03',scope:'#2b2d30'});
window.latest = null;
find.onResults(value => window.latest = value);
window.beats = 0;
setInterval(() => window.beats++,50);
await new Promise(resolve => term.write('a'.repeat(32)+'!',resolve));
window.search = query => find.find(query,{regex:true,caseSensitive:false,wholeWord:false},true,true);
window.ready = true;
</script>`;

const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "search-responsiveness",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__search_probe") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
});

async function deadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`renderer did not answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const report = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceSha256: createHash("sha256")
    .update(await readFile("src/terminalFind.ts"))
    .digest("hex"),
  os: `${os.platform()} ${os.release()}`,
  mode: "Vite development; real xterm DOM; one synthetic terminal; no IPC",
  workload: { query: "^(a+)+$", text: "32 a characters followed by !", cols: 80, rows: 24 },
  repetitions: 1,
  boundary: "Front-end liveness fixture only; not native WebView2 or a real server measurement",
};
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.PERF_BROWSER || "msedge",
    headless: true,
  });
  report.browser = browser.version();
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}__search_probe`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => setTimeout(() => window.search("^(a+)+$"), 0));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const start = performance.now();
  report.heartbeat = await deadline(
    page.evaluate(() => window.beats),
    2000,
  );
  report.responseMs = performance.now() - start;
  await page.waitForFunction(() => window.latest?.error === "timeout", null, { timeout: 5000 });
  report.timeout = await page.evaluate(() => window.latest);
  await page.evaluate(() => window.search("a+"));
  await page.waitForFunction(() => window.latest?.resultCount === 1 && !window.latest.busy);
  report.recovered = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), server.close()]);
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length) {
    report.passed = false;
    report.cleanupErrors = failures.map((result) => String(result.reason));
    process.exitCode = 1;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
