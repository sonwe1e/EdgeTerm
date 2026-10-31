// A disposable portable Windows app only: exercise the real WebView2,
// ConPTY and sidebar splitter with synthetic shell output. CDP mouse input is
// still not an OS pointer gesture or the user's OpenCode workload.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const target = process.env.EDGETERM_CDP_TARGET_ID;
assert.ok(target, "Select the disposable page with EDGETERM_CDP_TARGET_ID");
assert.ok(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
await mkdir(output);
const fixture = resolve(output, "files");
await mkdir(fixture);
const browser = await chromium.connectOverCDP(
  process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9241",
);
const result = { rounds: [], errors: [] };
const sessions = new Set();
let page;
const invoke = (cmd, args = {}) =>
  page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const session = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === target) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()), "Select the disposable EdgeTerm page");
  assert.equal(await invoke("portable_mode"), true, "Use an isolated portable data directory");
  assert.deepEqual(await invoke("list_sessions"), [], "The test instance must have no sessions");
  assert.deepEqual(await invoke("list_profiles"), [], "The test instance must have no profiles");
  assert.equal(await page.locator(".tab").count(), 0, "The test instance must have no tabs");
  result.environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    gpuRenderer: localStorage.getItem("edgeterm.gpuRenderer"),
  }));
  page.on("pageerror", (error) => result.errors.push(String(error)));
  if ((await page.locator(".filer-panel").count()) === 0) {
    await page.keyboard.press("Control+Alt+ArrowRight");
  }
  await page.locator(".filer-panel").waitFor();
  await page.locator(".filer-path input").fill(fixture);
  await page.locator(".filer-path input").press("Enter");
  await page.waitForFunction(
    (path) => document.querySelector(".filer-breadcrumbs")?.getAttribute("aria-label") === path,
    fixture,
  );
  for (let n = 0; n < 3; n++) {
    console.log(`Opening isolated shell ${n + 1}/3`);
    await page
      .getByText(/^(Local Shell|本地 Shell)$/)
      .first()
      .dblclick();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".tab").length === count,
      n + 1,
    );
    await page.waitForFunction(
      async (count) => (await window.__TAURI_INTERNALS__.invoke("list_sessions")).length === count,
      n + 1,
    );
    for (const session of await invoke("list_sessions")) sessions.add(session.id);
  }
  const firstId = [...sessions][0];
  await page.keyboard.press("Alt+1");
  await page.waitForFunction(
    () => document.querySelector(".tab.is-active .tab-index")?.textContent?.trim() === "1.",
  );
  await invoke("write_session", {
    id: firstId,
    data: `cd /d "${fixture}"\rfor /l %i in (1,1,3000) do @echo DRAG-FIXTURE-LINE-%i 01234567890123456789\r`,
  });
  await page.keyboard.press("Control+Shift+F");
  await page.locator(".terminal-search input").fill("DRAG-FIXTURE-LINE-3000");
  await page.waitForFunction(
    () =>
      /^(?:[1-9]\d*\/)?[1-9]\d*\+?$/.test(
        document.querySelector(".search-count")?.textContent?.trim() || "",
      ),
    null,
    { timeout: 30000 },
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  result.environment.screenRenderer =
    (await page.locator(".pane-slot:not(.is-hidden) .xterm-screen canvas").count()) > 0
      ? "canvas"
      : "DOM";
  await page.evaluate(() => {
    const screen = document.querySelector(".pane-slot:not(.is-hidden) .xterm-screen");
    const probe = { widths: [], observer: null };
    probe.observer = new ResizeObserver(() =>
      probe.widths.push(screen.getBoundingClientRect().width),
    );
    probe.observer.observe(screen);
    window.__sidebarDragProbe = probe;
  });
  await page.waitForTimeout(100);
  const center = page.locator(".main > .center");
  const splitter = page.locator(".main > .center + .splitter.is-vertical");
  const screen = page.locator(".pane-slot:not(.is-hidden) .xterm-screen");
  for (let round = 0; round < 6; round++) {
    console.log(`Dragging the sidebar ${round + 1}/6`);
    const before = await center.boundingBox();
    const handle = await splitter.boundingBox();
    const beforeScreen = await screen.boundingBox();
    assert.ok(before && handle && beforeScreen, "The sidebar and terminal must be visible");
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    const direction = round % 2 === 0 ? -1 : 1;
    await page.evaluate(() => {
      window.__sidebarDragProbe.widths = [];
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    const observations = [];
    for (const delta of [24, 48, 72]) {
      await page.mouse.move(x + direction * delta, y);
      await page.waitForTimeout(150);
      observations.push(
        await page.evaluate(() => ({
          width: document.querySelector(".main > .center").getBoundingClientRect().width,
          screen: document
            .querySelector(".pane-slot:not(.is-hidden) .xterm-screen")
            .getBoundingClientRect().width,
          screenChanges: window.__sidebarDragProbe.widths.length,
        })),
      );
    }
    const preview = await splitter.evaluate(
      (node) => new DOMMatrix(getComputedStyle(node, "::before").transform).m41,
    );
    if (round === 0) await page.screenshot({ path: resolve(output, "drag-preview.png") });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const after = await center.boundingBox();
    const afterScreen = await screen.boundingBox();
    const screenChanges = await page.evaluate(() => window.__sidebarDragProbe.widths);
    result.rounds.push({
      before: before.width,
      beforeScreen: beforeScreen.width,
      preview,
      observations,
      after: after.width,
      afterScreen: afterScreen.width,
      screenChanges,
    });
    assert.ok(observations.every(({ width }) => Math.abs(width - before.width) <= 1));
    assert.ok(observations.every(({ screen }) => Math.abs(screen - beforeScreen.width) <= 1));
    assert.ok(observations.every(({ screenChanges }) => screenChanges === 0));
    assert.ok(Math.abs(after.width - before.width - preview) <= 1);
    assert.ok(
      Math.abs(afterScreen.width - beforeScreen.width) > 1,
      "The terminal must fit after release",
    );
    assert.equal(new Set(screenChanges.map((width) => Math.round(width))).size, 1);
  }
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (page) {
    await page.evaluate(() => window.__sidebarDragProbe?.observer.disconnect()).catch(() => {});
    for (const id of sessions) await invoke("close_session", { id }).catch(() => {});
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  await browser.close();
  console.log(
    JSON.stringify({
      passed: result.passed,
      failure: result.failure,
      rounds: result.rounds.length,
    }),
  );
}
