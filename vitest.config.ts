import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two projects share one runner. "unit" keeps the fast jsdom loop for daily
// work (npm test); "browser" runs the *.browser.test.ts files in a real
// Edge/Chromium page (npm run test:browser) for the contracts jsdom cannot
// see: real layout measurement, pointer capture, media queries. The browser
// project does NOT inherit src/test/setup.ts — those are jsdom stubs
// (canvas, matchMedia, rAF) and would mask exactly what the browser
// environment is here to prove. Both projects include styles.css as real
// CSS: without it vitest stubs every CSS import, `?raw` included.
export default defineConfig({
  test: {
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
      },
      {
        test: {
          name: "browser",
          css: { include: [/styles\.css/] },
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { channel: "msedge" } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
