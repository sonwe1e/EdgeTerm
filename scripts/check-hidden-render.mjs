// Browser gate for hidden terminals: real xterm, real styles.css, headless
// Edge, synthetic output only (no Tauri, no sessions, no network).
//
// Counts the frames xterm renders while its pane slot is hidden and a program
// keeps writing, for the app's own `.pane-slot.is-hidden` and for the
// `visibility: hidden` it used before, so a regression shows as a number.
// Exit 1 when the app's hidden slot still renders. This proves the renderer
// pauses in Chromium; it does not measure WebView2, WebKitGTK or old GPUs.
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head>
<body><div id="stage" style="position:relative;width:900px;height:500px"></div>
<script type="module">
import { TerminalController } from '/src/terminal.ts';
window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback: () => 1, unregisterCallback() {}, invoke: async () => undefined };
const slot = document.createElement('div');
slot.className = 'pane-slot';
slot.style.cssText = 'left:0;top:0;width:100%;height:100%';
const pane = document.createElement('div');
pane.className = 'term-pane';
slot.appendChild(pane);
document.getElementById('stage').appendChild(slot);
const controller = new TerminalController('hidden-gate', {
  onData() {}, onResize() {}, onStatus() {}, onCommand() {},
  onCommandState() {}, suggest: () => [], forgetSuggestion() {},
}, 13, 10000);
controller.attach(pane);
controller.setVisible(true);
controller.fit(true);
let renders = 0;
controller.term.onRender(() => { renders += 1; });
// A spinner-like writer: one line of output per animation frame.
let n = 0, running = false;
const tick = () => {
  if (!running) return;
  controller.term.write('\\r\\x1b[2Kworking ' + (n++) + ' 10.0.0.1 GET /api/items\\r\\n');
  requestAnimationFrame(tick);
};
const frames = (count) => new Promise((resolve) => {
  const step = () => (count-- <= 0 ? resolve() : requestAnimationFrame(step));
  step();
});
window.measure = async (hide, show, frameCount) => {
  hide(slot); running = true; tick();
  await frames(10);
  renders = 0;
  await frames(frameCount);
  const count = renders;
  running = false;
  show(slot);
  await frames(5);
  return count;
};
window.hideApp = (el) => { el.classList.add('is-hidden'); controller.setVisible(false); };
window.showApp = (el) => { el.classList.remove('is-hidden'); controller.setVisible(true); controller.fit(true); };
window.hideLegacy = (el) => { el.style.visibility = 'hidden'; el.style.zIndex = '-1'; controller.setVisible(false); };
window.showLegacy = (el) => { el.style.visibility = ''; el.style.zIndex = ''; controller.setVisible(true); controller.fit(true); };
window.visibleCount = () => renders;
window.ready = true;
</script></body></html>`;

const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "hidden-render-harness", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__hidden_render") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, html));
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PERF_BROWSER || "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(server.resolvedUrls.local[0] + "__hidden_render");
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });

  const FRAMES = 120;
  const result = await page.evaluate(async (frames) => {
    const slot = document.querySelector(".pane-slot");
    const shown = await window.measure(() => {}, () => {}, frames);
    const legacy = await window.measure(window.hideLegacy, window.showLegacy, frames);
    const app = await window.measure(window.hideApp, window.showApp, frames);
    const display = getComputedStyle(slot).display;
    return { frames, shown, legacyVisibilityHidden: legacy, appIsHidden: app, display };
  }, FRAMES);
  console.log(JSON.stringify({ browser: browser.version(), ...result }, null, 2));
  assert.deepEqual(errors, [], "page errors: " + errors.join("; "));
  assert.ok(result.shown > FRAMES / 4,
    `harness check: a visible terminal should render under constant output, saw ${result.shown}/${FRAMES}`);
  assert.ok(result.appIsHidden <= 2,
    `a hidden .pane-slot rendered ${result.appIsHidden} frames of ${FRAMES} under constant output`);
  await mkdir("artifacts/performance", { recursive: true });
  await writeFile("artifacts/performance/hidden-render.json", JSON.stringify(result, null, 2));
  console.log("hidden terminal render gate: pass");
} finally {
  if (browser) await browser.close();
  await server.close();
}
