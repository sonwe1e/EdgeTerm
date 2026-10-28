// Native Windows acceptance, not a headless/component benchmark. Start a
// disposable portable release with WebView2 CDP, then explicitly select its
// page via EDGETERM_CDP_TARGET_ID (the same guard as the older CDP scripts).
// Usage: EDGETERM_CDP_URL=http://127.0.0.1:9241 node scripts/check-native-terminal-tabs.mjs <new-output-dir>
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const target = process.env.EDGETERM_CDP_TARGET_ID;
assert.ok(target, "Select the disposable page with EDGETERM_CDP_TARGET_ID");
const output = resolve(process.argv[2] || "");
assert.ok(process.argv[2], "Pass a new output directory");
await mkdir(output); // Never overwrite an earlier run.
const browser = await chromium.connectOverCDP(
  process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9241",
);
let page;
const result = {
  samples: [],
  bursts: [],
  backgroundBursts: [],
  hiddenRows: [],
  hiddenMutations: [],
  errors: [],
};
const createdSessions = new Set();
let observer;
let profiling = false;
let phase = "select-instance";
const invoke = (cmd, args = {}) =>
  page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const session = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === target) page = candidate;
  }
  assert.ok(
    page && /tauri.localhost/.test(page.url()),
    "Selected target must be the test EdgeTerm",
  );
  assert.equal(await invoke("portable_mode"), true, "Use an isolated portable data directory");
  assert.deepEqual(await invoke("list_sessions"), [], "Test instance must start without sessions");
  assert.equal(await page.locator(".tab").count(), 0, "Test instance must start without tabs");
  assert.deepEqual(
    await invoke("list_profiles"),
    [],
    "Test instance must start without saved profiles",
  );
  assert.notEqual(await page.evaluate(() => localStorage.getItem("edgeterm.gpuRenderer")), "off");
  result.environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    scrollback: localStorage.getItem("edgeterm.terminalScrollback") || "default 10000",
  }));
  page.on("pageerror", (error) => result.errors.push(String(error)));
  const openShell = async () => {
    phase = `open-shell-${createdSessions.size + 1}`;
    console.log(phase);
    await page
      .getByText(/^(Local Shell|本地 Shell)$/)
      .first()
      .dblclick();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".tab").length === count,
      createdSessions.size + 1,
    );
    // The UI creates a connecting tab before its backend session is ready.
    const deadline = performance.now() + 30000;
    let added = [];
    while (added.length === 0 && performance.now() < deadline) {
      added = (await invoke("list_sessions")).filter(({ id }) => !createdSessions.has(id));
      if (added.length === 0) await page.waitForTimeout(25);
    }
    assert.equal(added.length, 1, "Each open must create exactly one test session");
    createdSessions.add(added[0].id);
    return added[0].id;
  };
  const firstId = await openShell();
  await page.waitForSelector(".xterm-helper-textarea");
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 1);
  for (let index = 0; index < 7; index++) {
    await openShell();
  }
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 8);
  await page.waitForTimeout(1000);
  assert.equal((await invoke("list_sessions")).length, 8);
  await page.keyboard.press("Alt+1");
  await page.waitForFunction(
    () => document.querySelector(".tab.is-active .tab-index")?.textContent?.trim() === "1.",
  );
  const search = async (query) => {
    if (!(await page.locator(".terminal-search").count()))
      await page.keyboard.press("Control+Shift+F");
    await page.locator(".terminal-search input").fill(query);
    await page.waitForFunction(() =>
      /^(?:[1-9]\d*\/)?[1-9]\d*\+?$/.test(
        document.querySelector(".search-count")?.textContent?.trim() || "",
      ),
    );
    return page.locator(".search-count").innerText();
  };
  // Three background sessions produce output at the same time while the
  // first remains visible. Visit each afterwards and search for its final row
  // so completing the commands is not mistaken for consuming their output.
  const backgroundIds = [...createdSessions].slice(1, 4);
  const backgroundStart = performance.now();
  await Promise.all(
    backgroundIds.map((id, index) =>
      invoke("write_session", {
        id,
        data: `for /l %i in (1,1,1500) do @echo NATIVE-BG-${index + 2}-LINE-%i 012345678901234567890123456789\r`,
      }),
    ),
  );
  for (let index = 0; index < backgroundIds.length; index++) {
    phase = `search-background-${index + 2}`;
    console.log(phase);
    await page.keyboard.press(`Alt+${index + 2}`);
    await page.waitForFunction(
      (number) =>
        document.querySelector(".tab.is-active .tab-index")?.textContent?.trim() === `${number}.`,
      index + 2,
    );
    const finalLineSearch = await search(`NATIVE-BG-${index + 2}-LINE-1500`);
    result.backgroundBursts.push({
      tab: index + 2,
      finalLineSearch,
      observedAfterMs: performance.now() - backgroundStart,
    });
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("Alt+1");
  for (let run = 1; run <= 3; run++) {
    phase = `foreground-burst-${run}`;
    console.log(phase);
    await page.keyboard.press("Escape");
    const start = performance.now();
    await invoke("write_session", {
      id: firstId,
      data: `for /l %i in (1,1,20000) do @echo NATIVE-R${run}-LINE-%i 01234567890123456789012345678901234567890123456789\r`,
    });
    result.bursts.push({
      run,
      lastLineSearch: await search(`NATIVE-R${run}-LINE-20000`),
      ms: performance.now() - start,
    });
    await page.keyboard.press("Escape");
  }
  await page.locator(".pane-slot:not(.is-hidden) .xterm-helper-textarea").focus();
  await page.keyboard.type("echo NATIVE-INTERACTIVE-OK");
  await page.keyboard.press("Enter");
  result.interactiveSearch = await search("NATIVE-INTERACTIVE-OK");
  await page.waitForFunction(() =>
    /^(?:[1-9]\d*\/)?2$/.test(document.querySelector(".search-count")?.textContent?.trim() || ""),
  );
  result.interactiveSearch = await page.locator(".search-count").innerText();
  await page.keyboard.press("Escape");
  observer = await page.context().newCDPSession(page);
  await observer.send("Profiler.enable");
  await observer.send("Profiler.start");
  profiling = true;
  await page.evaluate(() => {
    window.__tabGateLongTasks = [];
    window.__tabGateObserver = new PerformanceObserver((list) => {
      window.__tabGateLongTasks.push(
        ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
      );
    });
    window.__tabGateObserver.observe({ type: "longtask" });
  });
  for (let round = 0; round < 3; round++) {
    phase = `switch-round-${round + 1}`;
    console.log(phase);
    for (let index = 1; index <= 8; index++) {
      const start = performance.now();
      await page.keyboard.press(`Alt+${index}`);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const ms = performance.now() - start;
      const active = await page.locator(".tab.is-active .tab-index").innerText();
      assert.equal(active, `${index}.`, "Shortcut must actually select the measured tab");
      result.samples.push({ round, index, ms });
    }
    await page.waitForTimeout(150); // Let xterm's hidden idle resize run too.
    result.hiddenRows.push(
      await page
        .locator(".pane-slot.is-hidden .xterm-rows")
        .evaluateAll((rows) => rows.map((row) => row.textContent.length)),
    );
    // A fallback may retain rows painted while it was visible. Watch for new
    // hidden updates after settling rather than requiring its DOM to be empty.
    result.hiddenMutations.push(
      await page.evaluate(
        () =>
          new Promise((done) => {
            let mutations = 0;
            const observer = new MutationObserver((records) => {
              mutations += records.length;
            });
            for (const row of document.querySelectorAll(".pane-slot.is-hidden .xterm-rows")) {
              observer.observe(row, { childList: true, characterData: true, subtree: true });
            }
            setTimeout(() => {
              observer.disconnect();
              done(mutations);
            }, 120);
          }),
      ),
    );
  }
  const { profile } = await observer.send("Profiler.stop");
  profiling = false;
  await writeFile(resolve(output, "profile.json"), JSON.stringify(profile));
  result.longTasks = await page.evaluate(() => {
    window.__tabGateObserver.disconnect();
    return window.__tabGateLongTasks;
  });
  await page.keyboard.press("Alt+1");
  result.retainedLastLine = await search("NATIVE-R3-LINE-20000");
  await page.screenshot({ path: resolve(output, "terminal.png") });
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.hiddenRows.every((rows) => rows.length === 2) &&
      result.hiddenMutations.every((count) => count === 0),
    "Hidden DOM fallbacks changed after settling; see hiddenRows and hiddenMutations",
  );
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  result.phase = phase;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (page) {
    await page.evaluate(() => window.__tabGateObserver?.disconnect()).catch(() => undefined);
    if (profiling) await observer.send("Profiler.stop").catch(() => undefined);
    for (const id of createdSessions) {
      await invoke("close_session", { id }).catch(() => undefined);
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      passed: result.passed,
      failure: result.failure,
      samples: result.samples,
      hiddenRows: result.hiddenRows,
      hiddenMutations: result.hiddenMutations,
    }),
  );
  await observer?.detach();
  await browser.close();
}
