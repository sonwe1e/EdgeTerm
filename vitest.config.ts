import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// The platform globals vite.config.ts bakes in for production builds
// (src/platform.ts). This file is standalone — inline projects do not extend
// vite.config.ts — so the tests must restate the same build-time facts from
// the same source of truth (the Node host's process.platform). The browser
// project serves modules raw and does not run vitest's node-side define
// injection, so without these the production imports fail to load.
const targetIsMac = process.platform === "darwin";
const targetIsWindows = process.platform === "win32";
// `__EDGETERM_TEST_HOST__` exists only for the tests: a truthful host-bound
// oracle for the platform defines (the repository builds on three operating
// systems, so a hardcoded OS literal would be wrong somewhere). It names the
// host vitest runs on — the same source of truth the production defines use.
const platformDefines = {
  __EDGETERM_MAC__: JSON.stringify(targetIsMac),
  __EDGETERM_WINDOWS__: JSON.stringify(targetIsWindows),
  __EDGETERM_TEST_HOST__: JSON.stringify(process.platform),
};

// The browser project's vite server discovers dependencies lazily; a test
// file that is the first to import, say, zustand used to trigger a
// mid-run re-optimization that reloaded the page and mixed React instances
// ("Cannot read properties of null (reading 'useCallback')"). Declaring the
// dependency set up front keeps every module on one instance.
const browserOptimizeDeps = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-dev-runtime",
  "zustand",
  "zustand/react/shallow",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-unicode11",
  "@xterm/addon-web-links",
  "@xterm/addon-webgl",
  "@tauri-apps/api/core",
  "@tauri-apps/api/event",
  "@tauri-apps/api/webview",
  "@tauri-apps/plugin-dialog",
  "@tauri-apps/plugin-opener",
  "zmodem.js",
];

// Two projects share one runner. "unit" keeps the fast jsdom loop for daily
// work (npm test); "browser" runs the *.browser.test.ts files in a real
// Edge/Chromium page (npm run test:browser) for the contracts jsdom cannot
// see: real layout measurement, pointer capture, media queries. The browser
// project does NOT inherit src/test/setup.ts — those are jsdom stubs
// (canvas, matchMedia, rAF) and would mask exactly what the browser
// environment is here to prove. Both projects include styles.css as real
// CSS: without it vitest stubs every CSS import, `?raw` included.
//
// The browser comes from Playwright's own Chromium by default (`npx
// playwright install chromium` on a clean machine). Setting PERF_BROWSER
// drives a system channel instead — PERF_BROWSER=msedge runs the installed
// Microsoft Edge, the same knob the check-*.mjs scripts use.
const channel = process.env.PERF_BROWSER?.trim();

export default defineConfig({
  test: {
    // Keep the default runner safe even when invoked through npx directly.
    maxWorkers: 2,
    maxConcurrency: 2,
    projects: [
      {
        test: {
          name: "unit",
          environment: "jsdom",
          css: { include: [/styles\.css/] },
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
          exclude: ["src/**/*.browser.test.ts", "**/node_modules/**", "**/dist/**"],
          setupFiles: ["src/test/setup.ts"],
        },
        define: { ...platformDefines },
      },
      {
        test: {
          name: "browser",
          css: { include: [/styles\.css/] },
          include: ["src/**/*.browser.test.ts"],
          browser: {
            fileParallelism: false,
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: channel ? { channel } : {} }),
            instances: [{ browser: "chromium" }],
          },
        },
        define: { ...platformDefines },
        optimizeDeps: { include: [...browserOptimizeDeps] },
      },
    ],
  },
});
