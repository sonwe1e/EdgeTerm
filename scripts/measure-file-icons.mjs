// First-open measurement for the file icon pipeline, run against a PRODUCTION
// build of an isolated page: the real FileBrowser component and stylesheet
// (scripts/icon-probe/entry.tsx), no app entry, no Tauri runtime, no IPC.
//
//   node scripts/measure-file-icons.mjs --variant candidate|baseline [--samples N] [--out <file>]
//
// The candidate variant builds the repository as it stands; the baseline
// variant builds the same fixture against the pre-change fileIcons module
// (extracted from commit 91b962b, its relative import re-pointed), so both
// sides run the same source semantics through the same minified pipeline.
//
// Metric: ms from the probe entry's module evaluation to the moment every
// rendered row icon <img> has completed loading (naturalWidth > 0). That is
// "first visible listing fully drawn, icons included" for this fixture. It
// excludes the real app entry, Tauri IPC, and WebView2 - a DOM fixture in a
// stock browser, not a desktop measurement. A sample fails (nonzero exit) if
// any icon img ends up broken, if the probe never settles, or if the page
// raises an error. The browser channel follows PERF_BROWSER (default:
// Playwright's chromium); an invalid channel fails the run.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

const variant = arg("--variant");
if (variant !== "candidate" && variant !== "baseline") {
  console.error("usage: node scripts/measure-file-icons.mjs --variant candidate|baseline [--samples N] [--out file]");
  process.exit(2);
}
const samples = Number(arg("--samples", "5"));
if (!Number.isInteger(samples) || samples < 1) {
  console.error("--samples must be a positive integer");
  process.exit(2);
}

const root = process.cwd();
const work = join(root, ".tmp", "icon-probe", variant);
await mkdir(work, { recursive: true });

// The baseline variant swaps in the pre-change icon module through an
// EXPLICIT resolveId: an alias regex on the resolved path failed to intercept
// FileIcon's relative "../fileIcons" specifier, which silently measured the
// same variant twice (A/A). The plugin intercepts the un-resolved source
// specifier from any importer inside src/, pointing it at the extracted
// pre-change module. After each build the variant is verified from the
// OUTPUT itself - the URL variant emits per-icon .svg assets and no
// createObjectURL; the blob variant does the opposite - and the run aborts
// if the wrong variant came out.
const variantProbe = variant === "baseline" ? "baseline" : "candidate";
let baselinePath;
if (variantProbe === "baseline") {
  const original = execFileSync("git", ["show", "91b962b:src/fileIcons.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  const rebased = original.replace(
    'from "./types"',
    'from "../../../src/types"',
  );
  const baselineDir = join(root, ".tmp", "icon-probe", "baseline-src");
  await mkdir(baselineDir, { recursive: true });
  baselinePath = join(baselineDir, "fileIcons.ts");
  await writeFile(baselinePath, rebased);
}

const variantPlugin = {
  name: "icon-probe-variant",
  enforce: "pre",
  resolveId(source, importer) {
    if (variantProbe !== "baseline") return undefined;
    const clean = source.replace(/\.ts$/, "");
    // Vite ids use forward slashes on every platform.
    if (
      importer &&
      importer.includes("src/components") &&
      (clean === "../fileIcons" || clean.endsWith("/fileIcons"))
    ) {
      return baselinePath;
    }
    return undefined;
  },
};

const html = `<!doctype html><html><head><title>icon-probe</title></head>
<body style="margin:0"><div id="root" style="width:1100px;height:720px"></div>
<script type="module" src="/scripts/icon-probe/entry.tsx"></script></body></html>`;
await writeFile(join(work, "probe.html"), html);

await build({
  configFile: false,
  root,
  plugins: [react(), variantPlugin],
  // The app's vite.config.ts defines these for the build target OS; the probe
  // takes the neutral neither-mac-nor-windows path.
  define: {
    __EDGETERM_MAC__: JSON.stringify(false),
    __EDGETERM_WINDOWS__: JSON.stringify(false),
  },
  build: {
    outDir: join(work, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: join(work, "probe.html") },
  },
  logLevel: "error",
});

// Verify the variant from the build output before measuring anything.
{
  const outAssets = join(work, "dist", "assets");
  const files = await readdir(outAssets);
  const svgCount = files.filter((name) => name.endsWith(".svg")).length;
  const chunkName = files.find((name) => /fileIcons.*\.js$/.test(name));
  const chunkCode = await readFile(join(outAssets, chunkName), "utf8");
  const hasBlob = chunkCode.includes("createObjectURL");
  const expectedSvg = variantProbe === "candidate";
  if (expectedSvg !== svgCount > 0 || hasBlob === expectedSvg) {
    throw new Error(
      `variant binding check failed: built ${variantProbe} but found ` +
        `${svgCount} svg assets and createObjectURL=${hasBlob}`,
    );
  }
}

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
// Vite emits the input html under its root-relative path, so "/" maps to
// dist/.tmp/icon-probe/<variant>/probe.html; asset URLs stay absolute.
const servedHtml = join(work, "dist", ".tmp", "icon-probe", variant, "probe.html");
const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const path = url === "/"
    ? servedHtml
    : join(work, "dist", decodeURIComponent(url.slice(1)));
  readFile(path)
    .then((body) => {
      res.setHeader(
        "content-type",
        MIME[join(path).slice(join(path).lastIndexOf("."))] ?? "application/octet-stream",
      );
      res.end(body);
    })
    .catch(() => {
      res.statusCode = 404;
      res.end("not found");
    });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const channel = process.env.PERF_BROWSER?.trim();
let browser;
const samplesOut = [];
const pageErrors = [];
try {
  browser = await chromium.launch(
    channel ? { channel, headless: true } : { headless: true },
  );
  for (let i = 0; i < samples; i += 1) {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 720 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(`${base}/`);
    const settled = await page
      .waitForFunction(() => window.__probe !== undefined, undefined, {
        timeout: 30000,
        polling: 50,
      })
      .then(() => true, () => false);
    if (!settled) {
      const state = await page.evaluate(() => ({
        rows: document.querySelectorAll(".ftp-file-row").length,
        imgs: document.querySelectorAll(".ftp-file-row img").length,
        rootChildren: document.getElementById("root")?.children.length ?? -1,
      })).catch(() => null);
      throw new Error(
        `sample ${i + 1}: the probe never finished within 30s; pageErrors=${JSON.stringify(pageErrors)} dom=${JSON.stringify(state)}`,
      );
    }
    const probe = await page.evaluate(() => window.__probe);
    if (probe.broken > 0) {
      throw new Error(`sample ${i + 1}: ${probe.broken} icon img(s) failed to load`);
    }
    samplesOut.push(probe.firstIconsMs);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (pageErrors.length > 0) {
  throw new Error(`page errors during measurement: ${pageErrors.join("; ")}`);
}

samplesOut.sort((a, b) => a - b);
const result = {
  variant,
  samples: samplesOut.length,
  firstIconsMs: { samples: samplesOut, median: samplesOut[Math.floor(samplesOut.length / 2)] },
  scope:
    "production build of scripts/icon-probe/entry.tsx: real FileBrowser + styles.css, 21-row listing, ms from entry module evaluation until every rendered row icon img is complete; excludes the app entry, Tauri IPC and WebView2",
  expectedImgs: 21,
};
const text = JSON.stringify(result, null, 2);
const outPath = arg("--out");
if (outPath) {
  await writeFile(outPath, text);
  console.log(`wrote ${outPath}`);
}
console.log(text);
