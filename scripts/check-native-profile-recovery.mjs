// Native portable acceptance in three separate process launches: seed,
// blocked (after fault injection into this test data), and restored. Never
// point it at an installed copy or a user's configuration directory.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const [mode, dataArg, outputArg] = process.argv.slice(2);
assert.ok(["seed", "blocked", "restored"].includes(mode) && dataArg && outputArg,
  "Usage: node scripts/check-native-profile-recovery.mjs <seed|blocked|restored> <isolated-data-dir> <new-output-dir>");
const target = process.env.EDGETERM_CDP_TARGET_ID;
assert.ok(target, "Explicitly select the disposable EdgeTerm page");
const dataDir = await realpath(dataArg);
assert.ok(dataDir.startsWith(resolve(".tmp") + sep), "Only repository .tmp data directories are allowed");
const output = resolve(outputArg);
await mkdir(output);
const browser = await chromium.connectOverCDP(process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9241");
const result = { mode, pageErrors: [] };
let page;
const invoke = (cmd, args = {}) => page.evaluate(({ cmd, args }) =>
  window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
const capture = async (operation) => {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error }; }
};
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const session = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === target) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()));
  assert.equal(await invoke("portable_mode"), true);
  assert.deepEqual(await invoke("list_sessions"), []);
  page.on("pageerror", (error) => result.pageErrors.push(String(error)));
  const path = join(dataDir, "sessions.json");
  const before = mode === "blocked" ? await readFile(path) : null;
  result.loaded = await capture(() => invoke("list_profiles"));
  const profile = {
    id: mode === "seed" ? "original-profile" : "new-profile",
    name: mode === "seed" ? "Original test connection" : "New test connection",
    kind: "local",
  };
  result.saved = await capture(() => invoke("save_profile", { profile }));
  await page.waitForTimeout(300);
  result.uiText = await page.locator("body").innerText();
  await page.screenshot({ path: join(output, "startup.png") });
  if (mode === "blocked") {
    result.filePreserved = before.equals(await readFile(path));
    assert.equal(result.loaded.ok, false, "Corrupt profiles must report a load error");
    assert.equal(result.saved.ok, false, "Corrupt profiles must refuse a new save");
    assert.equal(result.filePreserved, true, "Original corrupt bytes must survive");
    assert.ok(result.uiText.includes("sessions.json") && result.uiText.includes("restart"),
      "Startup must display the recovery error instead of Ready");
  } else {
    assert.equal(result.loaded.ok, true);
    assert.equal(result.saved.ok, true);
    const profiles = await invoke("list_profiles");
    assert.ok(profiles.some((entry) => entry.id === "original-profile"));
    if (mode === "restored") assert.ok(profiles.some((entry) => entry.id === "new-profile"));
    result.profileCount = profiles.length;
  }
  assert.deepEqual(result.pageErrors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}
