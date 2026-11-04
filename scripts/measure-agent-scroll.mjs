// Compare the selected semantic-coloring path against HEAD in one browser.
// No native sessions, SSH, model calls or user conversation data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

assert.ok(process.argv[2], "Pass a fresh result path under .tmp");
const root = resolve(".");
const output = resolve(process.argv[2]);
assert.ok(output.startsWith(resolve(".tmp") + "/") || output.startsWith(resolve(".tmp") + "\\"));
const base = process.env.EDGETERM_AGENT_BASE || "HEAD";
const baseline = execFileSync("git", ["show", `${base}:src/terminalSemanticRenderer.ts`], {
  encoding: "utf8",
  windowsHide: true,
});
const candidate = await readFile(resolve("src/terminalSemanticRenderer.ts"), "utf8");
const html = `<!doctype html><script type="module">
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { TerminalSemanticRenderer } from '/src/terminalSemanticRenderer.ts';
window.run = async () => {
  const term = new Terminal({cols:80,rows:24,scrollback:10000,allowProposedApi:true});
  await new Promise(resolve => term.write('x'.repeat(800000), resolve));
  const renderer = new TerminalSemanticRenderer({term,visible:true,disposed:false});
  const buffer = term.buffer.active;
  const original = buffer.getLine.bind(buffer);
  const samples = [];
  let reads = 0;
  buffer.getLine = row => { reads++; return original(row); };
  for (let n=0;n<7;n++) {
    reads = 0;
    const start = performance.now(); renderer.refreshSemanticColors();
    const ms = performance.now()-start;
    if(n>=2) samples.push({ms,reads});
  }
  buffer.getLine = original;
  if (original(9999).translateToString(true) !== 'x'.repeat(80)) throw Error('text changed');
  renderer.stopBacklog(); term.dispose(); return samples;
};
window.ready=true;
</script>`;
const report = {
  baseline: execFileSync("git", ["rev-parse", base], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  candidateSha256: createHash("sha256").update(candidate).digest("hex"),
  os: `${os.platform()} ${os.release()}`,
  mode: "Vite development; real xterm; no attached renderer or IPC",
  workload: {
    cols: 80,
    rows: 24,
    scrollback: 10000,
    characters: 800000,
    warmups: 2,
    samplesPerRun: 5,
  },
  boundary:
    "Semantic viewport work only; not end-to-end scroll latency, GPU, WebView2, live agents or SSH",
  runs: [],
  errors: [],
};
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PERF_BROWSER || "msedge",
    headless: true,
  });
  report.browser = browser.version();
  for (const variant of ["baseline", "candidate", "candidate", "baseline"]) {
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "agent-scroll-measurement",
          enforce: "pre",
          transform(code, id) {
            if (
              variant === "baseline" &&
              id.split("?")[0].replaceAll("\\", "/").endsWith("/src/terminalSemanticRenderer.ts")
            )
              return baseline;
          },
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url !== "/__agent_scroll") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(await server.transformIndexHtml(req.url, html));
            });
          },
        },
      ],
    });
    let page;
    try {
      await server.listen();
      page = await browser.newPage();
      page.on("pageerror", (error) => report.errors.push(String(error)));
      await page.goto(`${server.resolvedUrls.local[0]}__agent_scroll`);
      await page.waitForFunction(() => window.ready);
      const samples = await page.evaluate(() => window.run());
      report.runs.push({ variant, samples });
    } finally {
      await page?.close();
      await server.close();
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
