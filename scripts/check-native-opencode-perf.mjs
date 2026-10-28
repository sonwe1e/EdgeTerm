// Real OpenCode TUI on a disposable portable EdgeTerm instance. The fixtures
// must be imported into a separate loopback-only OpenCode server beforehand;
// the app and its local shells must inherit that server's credentials and
// isolated data/config/cache/state/temp directories.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { chromium } from "playwright";

const target = process.env.EDGETERM_CDP_TARGET_ID;
const fixtureFile = process.env.EDGETERM_OPENCODE_FIXTURES;
const executable = process.env.EDGETERM_OPENCODE_EXE;
const project = process.env.EDGETERM_OPENCODE_PROJECT;
const server = new URL(process.env.EDGETERM_OPENCODE_SERVER || "http://127.0.0.1:9238");
assert.ok(
  target && fixtureFile && executable && project && process.argv[2],
  "pass the test paths, target ID, and a new output directory",
);
assert.equal(server.protocol, "http:");
assert.equal(server.hostname, "127.0.0.1", "OpenCode server must be isolated on loopback");
assert.equal(server.username + server.password, "", "do not put credentials in the URL");
const insideTmp = (path) => {
  const part = relative(resolve(".tmp"), resolve(path));
  return part && !part.startsWith("..") && !isAbsolute(part);
};
assert.ok(insideTmp(fixtureFile) && insideTmp(project) && insideTmp(process.argv[2]));
const fixtures = JSON.parse(await readFile(fixtureFile, "utf8"));
for (const name of ["short", "long"]) {
  assert.match(fixtures[name].id, /^ses_[a-zA-Z0-9]+$/);
}
const output = resolve(process.argv[2]);
await mkdir(output); // Do not overwrite another run.
const browser = await chromium.connectOverCDP(
  process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9241",
);
const result = { measurements: {}, switches: [], errors: [] };
const created = [];
let page;
let cdp;
let phase = "select-instance";
let profiling = false;
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const probe = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await probe.send("Target.getTargetInfo");
    await probe.detach();
    if (targetInfo.targetId === target) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()), "select the disposable EdgeTerm page");
  const invoke = (cmd, args = {}) =>
    page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
  assert.equal(await invoke("portable_mode"), true);
  const sessions = await invoke("list_sessions");
  const profiles = await invoke("list_profiles");
  assert.ok(
    Array.isArray(sessions) && sessions.length === 0,
    "test instance must have no sessions",
  );
  assert.ok(
    Array.isArray(profiles) && profiles.length === 0,
    "test instance must have no profiles",
  );
  assert.equal(await page.locator(".tab").count(), 0);
  result.environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    gpu: localStorage.getItem("edgeterm.gpuRenderer") || "default",
  }));
  page.on("pageerror", (error) => result.errors.push(String(error)));
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");

  const open = async (name) => {
    phase = `open-${created.length + 1}-${name}`;
    console.log(phase);
    await page
      .getByText(/^(Local Shell|本地 Shell)$/)
      .first()
      .dblclick();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".tab").length === count,
      created.length + 1,
    );
    const deadline = performance.now() + 30000;
    let added;
    while (!added && performance.now() < deadline) {
      added = (await invoke("list_sessions")).find(({ id }) => !created.includes(id));
      if (!added) await page.waitForTimeout(25);
    }
    assert.ok(added, "the shell must actually start");
    created.push(added.id);
    const command = `"${executable}" --server ${server.origin} --session ${fixtures[name].id} "${project}"\r`;
    await invoke("write_session", { id: added.id, data: command });
    await page.waitForTimeout(3500);
  };
  const select = async (index) => {
    await page.keyboard.press(`Alt+${index}`);
    await page.waitForFunction(
      (number) =>
        document.querySelector(".tab.is-active .tab-index")?.textContent?.trim() === `${number}.`,
      index,
    );
  };
  const begin = async () => {
    await cdp.send("Profiler.start");
    profiling = true;
    await page.evaluate(() => {
      const state = { running: true, frames: [], longTasks: [], wheelEvents: 0 };
      window.__opencodePerf = state;
      state.observer = new PerformanceObserver((list) => {
        state.longTasks.push(
          ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
        );
      });
      state.observer.observe({ type: "longtask" });
      state.wheel = () => {
        state.wheelEvents++;
      };
      document.addEventListener("wheel", state.wheel, true);
      const tick = (time) => {
        if (!state.running) return;
        state.frames.push(time);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
  const end = async (name) => {
    const timing = await page.evaluate(() => {
      const state = window.__opencodePerf;
      state.running = false;
      state.observer.disconnect();
      document.removeEventListener("wheel", state.wheel, true);
      return { frames: state.frames, longTasks: state.longTasks, wheelEvents: state.wheelEvents };
    });
    const { profile } = await cdp.send("Profiler.stop");
    profiling = false;
    await writeFile(resolve(output, `${name}-profile.json`), JSON.stringify(profile));
    const gaps = timing.frames.slice(1).map((time, index) => time - timing.frames[index]);
    return { ...timing, frameGaps: gaps };
  };
  const scroll = async (name) => {
    phase = name;
    console.log(phase);
    await page.waitForTimeout(1000);
    const box = await page.locator(".pane-slot:not(.is-hidden) .xterm-screen").boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100);
    const clip = {
      x: box.x + box.width * 0.08,
      y: box.y + box.height * 0.08,
      width: box.width * 0.6,
      height: box.height * 0.65,
    };
    const before = await page.screenshot({ path: resolve(output, `${name}-before.png`), clip });
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await begin();
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(300);
    const measurement = await end(name);
    const after = await page.screenshot({ path: resolve(output, `${name}-after.png`), clip });
    measurement.screenChanged = !before.equals(after);
    assert.equal(measurement.wheelEvents, 30, "wheel input must reach the page");
    assert.ok(measurement.screenChanged, "scrolling must change the visible content");
    result.measurements[name] = measurement;
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(500);
  };

  await open("short");
  await scroll("short-one-tab");
  await open("long");
  await scroll("long-two-tabs");
  for (let i = 0; i < 6; i++) await open("long");
  await select(2);
  await scroll("long-eight-tabs");
  phase = "switch-eight-tabs";
  console.log(phase);
  await begin();
  for (let round = 0; round < 3; round++) {
    for (let index = 1; index <= 8; index++) {
      const start = performance.now();
      await select(index);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      result.switches.push({ round, index, ms: performance.now() - start });
    }
    await page.waitForTimeout(150);
  }
  result.measurements[phase] = await end(phase);
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  result.phase = phase;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (profiling) await cdp?.send("Profiler.stop").catch(() => undefined);
  if (page) {
    for (const id of created) {
      await page
        .evaluate((id) => window.__TAURI_INTERNALS__.invoke("close_session", { id }), id)
        .catch(() => undefined);
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ passed: result.passed, phase: result.phase, failure: result.failure }),
  );
  await cdp?.detach();
  await browser.close();
}
