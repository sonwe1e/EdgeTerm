// Real packaged WebView2 + ConPTY. Only generated terminal output, no models.
// Run through dev.ps1 script, with an explicitly selected disposable CDP target.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
assert.ok(process.env.EDGETERM_CDP_TARGET_ID, "Select the disposable page explicitly");
assert.ok(process.argv[2], "Pass a new output directory under .tmp");
const output = resolve(process.argv[2]);
assert.ok(output.startsWith(resolve(".tmp") + sep));
await mkdir(output);
const statePath = resolve(output, "terminal-state.json");
const fixturePath = resolve(output, "terminal-fixture.cjs");
await writeFile(
  fixturePath,
  `const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
let mode = "one", bytes = [], generation = 0;
const save = () => fs.writeFileSync(statePath, JSON.stringify({ mode, bytes, generation, cols: process.stdout.columns, rows: process.stdout.rows }));
function paint() {
  const tui = mode === "tui";
  const text = tui ? "中文输出\\r\\n  second line" : mode === "two" ? "NATIVE-SELECT-TWO" : "NATIVE-SELECT-ONE";
  process.stdout.write((tui ? "\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h" : "\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l") + "\\x1b[?2004h\\x1b[2J\\x1b[H" + text);
  generation++; save();
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", data => {
  bytes.push(...data);
  const command = data.toString();
  if (command === "1") { mode = "one"; paint(); }
  else if (command === "2") { mode = "two"; paint(); }
  else if (command === "3") { mode = "tui"; paint(); }
  else if (command === "r") { process.stdout.write("\\x1b[2J\\x1b[HRedrawn output"); generation++; }
  save();
});
process.stdout.on("resize", save);
paint();
`,
);

const result = {
  checks: [],
  errors: [],
  boundary:
    "Packaged Windows WebView2/ConPTY, Playwright pointer input, generated output; no actual Codex/model/SSH session",
};
const browser = await chromium.connectOverCDP(process.env.EDGETERM_CDP_URL);
const createdSessions = new Set();
let page;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const state = async () => JSON.parse(await readFile(statePath, "utf8"));
async function poll(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const cdp = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach();
    if (targetInfo.targetId === process.env.EDGETERM_CDP_TARGET_ID) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()));
  assert.equal(await invoke("portable_mode"), true);
  assert.deepEqual(await invoke("list_sessions"), []);
  assert.deepEqual(await invoke("list_profiles"), []);
  page.on("pageerror", (error) => result.errors.push(String(error)));
  result.environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  await page
    .getByText(/^(Local Shell|本地 Shell)$/)
    .first()
    .dblclick();
  await poll(async () => (await invoke("list_sessions")).length === 1, "local shell");
  const id = (await invoke("list_sessions"))[0].id;
  createdSessions.add(id);
  await page.locator(".xterm-helper-textarea").waitFor();
  await invoke("write_session", { id, data: `"${process.execPath}" "${fixturePath}"\r` });
  await poll(async () => {
    try {
      return (await state()).mode === "one";
    } catch {
      return false;
    }
  }, "generated PTY output");
  await page.waitForTimeout(300);
  result.renderer = (await page.locator(".xterm-screen canvas").count()) ? "canvas" : "DOM";
  const editor = () => page.getByRole("textbox", { name: /^(Agent prompt|Agent 提示词)$/ });
  const add = () => page.getByRole("button", { name: /^(Add terminal selection|加入终端选区)$/ });
  async function drag(toCol, toRow = 0, shift = false) {
    const dimensions = await state();
    const box = await page.locator(".pane-slot:not(.is-hidden) .xterm-screen").boundingBox();
    assert.ok(box && dimensions.cols > 0 && dimensions.rows > 0);
    const x = (column) => box.x + ((column + 0.25) * box.width) / dimensions.cols;
    const y = (row) => box.y + ((row + 0.5) * box.height) / dimensions.rows;
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(x(0), y(0));
    await page.mouse.down();
    await page.mouse.move(x(toCol), y(toRow), { steps: 12 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  }
  async function quote(expected, label) {
    const before = (await state()).bytes;
    await add().click();
    await poll(async () => (await editor().inputValue()) === expected, label);
    await page.waitForTimeout(100);
    assert.deepEqual((await state()).bytes, before, "Quoting must not write to the PTY");
    result.checks.push({ label, draft: await editor().inputValue(), writesFromQuote: 0 });
    await page.screenshot({ path: resolve(output, `${result.checks.length}-quoted.png`) });
    console.log(`PASS ${label}`);
  }
  async function paint(command, mode) {
    const before = (await state()).generation;
    await invoke("write_session", { id, data: command });
    await poll(async () => {
      const s = await state();
      return s.mode === mode && s.generation > before;
    }, `paint ${mode}`);
    await page.waitForTimeout(200);
  }
  await drag(17);
  await page.screenshot({ path: resolve(output, "0-selected-before-open.png") });
  await page.locator(".agent-compose-launch").click();
  await editor().waitFor();
  await page.waitForTimeout(300);
  await quote("NATIVE-SELECT-ONE", "selection survives opening the composer");

  await editor().fill("Explain this:");
  await paint("2", "two");
  await drag(17);
  await quote("Explain this:\n\nNATIVE-SELECT-TWO", "selection while the composer is already open");

  await editor().fill("");
  await paint("3", "tui");
  await drag(13, 1, true);
  await page.screenshot({ path: resolve(output, "3-shift-selected.png") });
  await paint("r", "tui");
  await quote(
    "中文输出\n  second line",
    "Shift selection survives a fullscreen redraw with Chinese and indentation",
  );

  await editor().fill("");
  await paint("1", "one");
  await drag(17);
  await page.locator(".status-agent").click();
  await page.getByRole("dialog").waitFor();
  const modal = page.getByRole("dialog");
  const modalAdd = modal.getByRole("button", { name: /^(Add terminal selection|加入终端选区)$/ });
  const modalEditor = modal.getByRole("textbox", { name: /^(Agent prompt|Agent 提示词)$/ });
  const before = (await state()).bytes;
  await modalAdd.click();
  await poll(async () => (await modalEditor.inputValue()) === "NATIVE-SELECT-ONE", "modal quote");
  assert.deepEqual((await state()).bytes, before);
  result.checks.push({
    label: "selection in the full dialog",
    draft: await modalEditor.inputValue(),
    writesFromQuote: 0,
  });
  await page.screenshot({ path: resolve(output, "4-modal-quoted.png") });
  console.log("PASS selection in the full dialog");
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.failure = String(error.stack || error);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  for (const id of createdSessions)
    await invoke("close_session", { id }).catch((error) => result.errors.push(`cleanup: ${error}`));
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  await browser.close();
}
