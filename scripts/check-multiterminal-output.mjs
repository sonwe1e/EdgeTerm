// Synthetic multi-terminal diagnostic. It uses the real controller and xterm
// in headless Edge, without Tauri, a PTY or an AI CLI. It reports timings and
// scroll/semantic-pass counts, not a portable performance threshold.
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const name = process.argv[2] ?? "";
if (!/^[a-z0-9-]+$/.test(name)) {
  console.error("usage: node scripts/check-multiterminal-output.mjs <new-results-name>");
  process.exit(2);
}

const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head>
<body><div id="stage" style="position:relative;width:900px;height:500px"></div>
<script type="module">
import { TerminalController } from '/src/terminal.ts';
window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback: () => 1, unregisterCallback() {}, invoke: async () => undefined };
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const callbacks = { onData() {}, onResize() {}, onStatus() {}, onCommand() {},
  onCommandState() {}, suggest: () => [], forgetSuggestion() {} };

window.measureOutput = async (mode) => {
  const stage = document.getElementById('stage');
  const items = [];
  const counts = { visible: { scroll: 0, passes: 0, passMs: 0, backlogSlices: 0, backlogMs: 0 },
    hidden: { scroll: 0, passes: 0, passMs: 0, backlogSlices: 0, backlogMs: 0 } };
  for (let i = 0; i < 4; i++) {
    const slot = document.createElement('div');
    slot.className = 'pane-slot';
    slot.style.cssText = 'left:0;top:0;width:100%;height:100%';
    const pane = document.createElement('div'); pane.className = 'term-pane';
    slot.appendChild(pane); stage.appendChild(slot);
    const controller = new TerminalController('load-' + i, callbacks, 13, 10000);
    controller.attach(pane); controller.setVisible(true); controller.fit(true);
    if (i !== 0) { slot.classList.add('is-hidden'); controller.setVisible(false); }
    items.push({ controller, slot });
  }
  const write = (controller, bytes) => new Promise(resolve => controller.write(bytes, resolve));
  if (mode === 'alternate-idle') {
    // Seed unseen normal scrollback, then display a full-screen program.
    // A pause between redraws reveals backlog work that only serves the
    // covered normal buffer, not the screen the user is viewing.
    const first = items[0];
    first.slot.classList.add('is-hidden'); first.controller.setVisible(false);
    await write(first.controller, encoder.encode('normal history host 10.0.0.1\\r\\n'.repeat(8000)));
    first.slot.classList.remove('is-hidden'); first.controller.setVisible(true);
  }
  if (mode !== 'normal-scroll') {
    await Promise.all(items.map(({ controller }) => write(controller, encoder.encode('\\x1b[?1049h'))));
  }
  await nextFrame(); await nextFrame();
  for (let i = 0; i < items.length; i++) {
    const { controller } = items[i];
    const counter = i === 0 ? counts.visible : counts.hidden;
    const semantic = controller.semantic;
    const original = semantic.refreshSemanticColors.bind(semantic);
    semantic.refreshSemanticColors = () => {
      const start = performance.now();
      try { return original(); } finally { counter.passes++; counter.passMs += performance.now() - start; }
    };
    const backlog = semantic.runBacklog.bind(semantic);
    semantic.runBacklog = () => {
      const start = performance.now();
      try { return backlog(); } finally { counter.backlogSlices++; counter.backlogMs += performance.now() - start; }
    };
    controller.term.onScroll(() => { counter.scroll++; });
  }

  const batches = mode === 'alternate-idle' ? 6 : 80;
  const lines = mode === 'normal-scroll' ? 12 : 24;
  const roundMs = [];
  let maxTimerDelayMs = 0, lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); maxTimerDelayMs = Math.max(maxTimerDelayMs, now - lastTick - 16); lastTick = now;
  }, 16);
  const start = performance.now();
  for (let batch = 0; batch < batches; batch++) {
    const row = 'message ' + batch + ' host 10.0.0.1 GET /api/items completed with synthetic text';
    const payload = mode === 'normal-scroll'
      ? (row + '\\r\\n').repeat(lines)
      : '\\x1b[H' + Array.from({ length: lines }, (_, n) => '\\x1b[2K' + row + ' row ' + n + '\\r\\n').join('');
    const bytes = encoder.encode(payload);
    const round = performance.now();
    await Promise.all(items.map(({ controller }) => write(controller, bytes)));
    roundMs.push(performance.now() - round);
    await wait(mode === 'alternate-idle' ? 260 : 0);
  }
  const elapsedMs = performance.now() - start;
  clearInterval(timer);
  await nextFrame(); await nextFrame();
  const renderer = items[0].slot.querySelector('.xterm-screen > canvas') ? 'webgl' : 'dom';
  const lastText = items.map(({ controller }) => {
    const buf = controller.term.buffer.active;
    const lines = [];
    for (let i = buf.viewportY; i < Math.min(buf.length, buf.viewportY + controller.term.rows); i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\\n').includes('message ' + (batches - 1));
  });
  for (const { controller, slot } of items) { controller.dispose(); slot.remove(); }
  return { mode, terminals: 4, visible: 1, batches, linesPerBatch: lines, renderer,
    elapsedMs, maxTimerDelayMs, maxRoundMs: Math.max(...roundMs), counts, lastText };
};
window.ready = true;
</script></body></html>`;

const server = await createServer({
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.tmp/**"] } },
  plugins: [
    {
      name: "multiterminal-output-harness",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__multiterminal_output") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.PERF_BROWSER || "msedge",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0] + "__multiterminal_output");
  await page.waitForFunction(() => window.ready === true);
  const samples = [];
  for (const mode of ["normal-scroll", "alternate-redraw", "alternate-idle"]) {
    for (let i = 0; i < 3; i++) {
      samples.push(await page.evaluate((scenario) => window.measureOutput(scenario), mode));
    }
  }
  if (errors.length || samples.some((sample) => sample.lastText.some((found) => !found))) {
    throw new Error(`fixture failed: ${JSON.stringify({ errors, samples })}`);
  }
  const result = {
    browser: browser.version(),
    channel: process.env.PERF_BROWSER || "msedge",
    scope:
      "Synthetic streams; headless browser only. Timings include instrumentation and are not native or OpenCode measurements.",
    samples,
  };
  const dir = path.join(".tmp", "records", "multiterminal-output", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "results.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ...result, output: dir }, null, 2));
  const failures = samples.filter(
    (sample) =>
      (sample.mode === "normal-scroll" &&
        (sample.counts.hidden.scroll === 0 || sample.counts.hidden.passes !== 0)) ||
      (sample.mode === "alternate-idle" && sample.counts.visible.backlogSlices !== 0),
  );
  if (failures.length) {
    console.error("hidden scroll or covered scrollback work regressed");
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await server.close();
}
