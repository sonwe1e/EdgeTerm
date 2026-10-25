// Renders the production FileBrowser icon rows in both palettes with the real
// stylesheet and screenshots each: visual evidence that the URL-asset icon
// path draws the same icons the blob path did. Reuses the isolated production
// fixture (scripts/icon-probe/entry.tsx) through a dev server, so every
// import is transformed the way the app builds. DOM fixture in a real
// Chromium page - it proves rendering of the component and its CSS, not a
// real SFTP listing and not WebView2 performance.
//
//   node scripts/icon-screenshots.mjs [--out <dir>]
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

const out = arg("--out", join(".tmp", "records", "implementation-02", "icons"));
await mkdir(out, { recursive: true });

const blankPage = `<!doctype html><html><head><title>icon-gallery</title></head>
<body style="margin:0"><div id="root" style="width:980px;height:420px"></div>
<script type="module" src="/scripts/icon-probe/entry.tsx"></script></body></html>`;

const server = await createServer({
  root: process.cwd(),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "icon-gallery",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if ((req.url ?? "/").split("?")[0] === "/") {
            // Run the raw page through vite's html transform so the react
            // plugin's dev preamble and the vite client get injected.
            const transformed = await server.transformIndexHtml("/", blankPage);
            res.setHeader("content-type", "text/html");
            res.end(transformed);
            return;
          }
          next();
        });
      },
    },
  ],
});
await server.listen();
const { port } = server.httpServer.address();
const base = `http://127.0.0.1:${port}`;

const channel = process.env.PERF_BROWSER?.trim();
const browser = await chromium.launch(channel ? { channel, headless: true } : { headless: true });
try {
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 980, height: 420 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${base}/?theme=${theme}`);
    // The probe entry settles __probe once every rendered icon has loaded.
    await page
      .waitForFunction(() => window.__probe !== undefined, undefined, {
        timeout: 15000,
      })
      .catch(() => {});
    await page.waitForTimeout(300);
    const drawn = await page.evaluate(
      () => document.querySelectorAll(".ftp-file-row img[src]").length,
    );
    const shot = join(out, `${theme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(
      `${theme}: ${drawn} icons drawn -> ${shot}${errors.length ? ` (page errors: ${errors.join("; ")})` : ""}`,
    );
    if (drawn === 0 || errors.length > 0) process.exitCode = 1;
    await context.close();
  }
} finally {
  await browser.close();
  // vite's dev server close callback never fires while connections are
  // draining; close without waiting so the process can exit on its own.
  server.close();
}
