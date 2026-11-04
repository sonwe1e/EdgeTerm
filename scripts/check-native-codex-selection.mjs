// Actual installed Codex TUI, isolated configuration, loopback response fixture.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";
import assert from "node:assert/strict";
assert.equal(process.platform, "win32");
assert.ok(process.env.EDGETERM_CDP_TARGET_ID, "Select the disposable page explicitly");
assert.ok(process.argv[2], "Pass a new output directory under .tmp");
const output = resolve(process.argv[2]);
assert.ok(output.startsWith(resolve(".tmp") + sep));
assert.ok(
  process.env.EDGETERM_CODEX_EXE,
  "Set EDGETERM_CODEX_EXE to the installed Codex executable",
);
const codexExe = resolve(process.env.EDGETERM_CODEX_EXE);
assert.ok(!/[\r\n%!"]/.test(output + codexExe), "Paths must be literal cmd.exe paths");
await mkdir(output);
const home = resolve(output, "codex-home");
const project = resolve(output, "project");
await mkdir(home);
await mkdir(project);
const requests = [];
const checks = [];
const codexVersion = execFileSync(codexExe, ["--version"], { encoding: "utf8" }).trim();
const answer = "CODEX-SELECTION-ONE\n\n中文选区测试：保留这一段文字。\n\n    indentation stays";
const server = createServer((req, res) => {
  requests.push(req.url);
  req.resume();
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json");
    res.end('{"data":[]}');
    return;
  }
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    model: "gpt-5.4",
    status: "completed",
    output: [item],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: answer,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: answer,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [i, e] of events.entries())
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await writeFile(
  resolve(home, "config.toml"),
  `model = "gpt-5.4"
model_provider = "fixture"
check_for_update_on_startup = false
approval_policy = "never"
sandbox_mode = "read-only"
[windows]
sandbox = "unelevated"
[model_providers.fixture]
name = "Local UI fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[projects.${JSON.stringify(project.replaceAll("\\", "/"))}]
trust_level = "trusted"
[tui]
fullscreen_transcript = true
copy_on_select = "never"
`,
);
const launcher = resolve(output, "launch.cmd");
await writeFile(
  launcher,
  `@echo off\r\nsetlocal\r\nset "CODEX_HOME=${home}"\r\nset CODEX_NON_INTERACTIVE=\r\nset CODEX_CI=\r\nset CODEX_DAEMON_SHUTDOWN_SOCKET=\r\nset CODEX_THREAD_ID=\r\nset CODEX_SESSION_ID=\r\nset OPENAI_API_KEY=\r\nset OPENAI_BASE_URL=\r\n"${codexExe}" --no-daemon -C "${project}" "fixture test"\r\nendlocal\r\n`,
);
const browser = await chromium.connectOverCDP(process.env.EDGETERM_CDP_URL);
let page, id;
for (const context of browser.contexts())
  for (const candidate of context.pages()) {
    const cdp = await context.newCDPSession(candidate);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach();
    if (targetInfo.targetId === process.env.EDGETERM_CDP_TARGET_ID) page = candidate;
  }
assert.ok(page);
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  assert.equal(await invoke("portable_mode"), true);
  assert.deepEqual(await invoke("list_profiles"), []);
  assert.deepEqual(await invoke("list_sessions"), []);
  await page
    .getByText(/^(Local Shell|本地 Shell)$/)
    .first()
    .dblclick();
  await page.waitForTimeout(500);
  id = (await invoke("list_sessions"))[0].id;
  await invoke("write_session", { id, data: `"${launcher}"\r` });
  await page.waitForTimeout(12000);
  await page.locator(`[data-tab-id="${id}"]`).click();
  await page.locator(".pane-slot:not(.is-hidden) .xterm-helper-textarea").focus();
  await page.keyboard.type("fixture test", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  assert.ok(requests.includes("/v1/responses"), "Codex must call the local response fixture");
  await page.screenshot({ path: resolve(output, "codex-start.png") });
  const screen = page.locator(".pane-slot:not(.is-hidden) .xterm-screen");
  const box = await screen.boundingBox();
  const body = await page.locator("body").innerText();
  const [, cols, rows] = body.match(/窗口 (\d+)×(\d+)/);
  const point = (col, row) => ({
    x: box.x + ((col + 0.2) * box.width) / Number(cols),
    y: box.y + ((row + 0.5) * box.height) / Number(rows),
  });
  async function drag(shift) {
    const from = point(2, 8),
      to = point(21, 8);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  }
  await drag(false);
  await page.screenshot({ path: resolve(output, "ordinary-selected.png") });
  await page.locator(".agent-compose-launch").click();
  const editor = page.getByRole("textbox", { name: "Agent 提示词", exact: true });
  await page.getByRole("button", { name: "加入终端选区", exact: true }).click();
  checks.push({
    name: "ordinary Codex selection",
    actual: await editor.inputValue(),
    expected: "CODEX-SELECTION-ONE",
  });
  await page.screenshot({ path: resolve(output, "ordinary-quoted.png") });
  await editor.fill("");
  await page.getByRole("button", { name: "折叠发送器", exact: true }).click();
  await page.waitForTimeout(500);
  await drag(true);
  await page.screenshot({ path: resolve(output, "shift-selected.png") });
  const clip = {
    x: box.x + (2 * box.width) / Number(cols),
    y: box.y + (8 * box.height) / Number(rows),
    width: (20 * box.width) / Number(cols),
    height: box.height / Number(rows),
  };
  const beforeHover = await page.screenshot({ clip });
  const hover = point(30, 10);
  await page.mouse.move(hover.x, hover.y);
  await page.waitForTimeout(200);
  const afterHover = await page.screenshot({ clip });
  checks.push({
    name: "Shift selection stays visible after hover",
    actual: beforeHover.equals(afterHover),
    expected: true,
  });
  await page.screenshot({ path: resolve(output, "shift-after-hover.png") });
  await page.locator(".agent-compose-launch").click();
  await page.getByRole("button", { name: "加入终端选区", exact: true }).click();
  checks.push({
    name: "Shift Codex selection",
    actual: await editor.inputValue(),
    expected: "CODEX-SELECTION-ONE",
  });
  await page.screenshot({ path: resolve(output, "shift-quoted.png") });
  await editor.focus();
  await page.keyboard.press("Control+z");
  checks.push({ name: "Undo quote", actual: await editor.inputValue(), expected: "" });
  await page.keyboard.press("Control+Shift+z");
  checks.push({
    name: "Redo quote",
    actual: await editor.inputValue(),
    expected: "CODEX-SELECTION-ONE",
  });
  await page.getByRole("button", { name: "折叠发送器", exact: true }).click();
  await page.getByRole("button", { name: "新建命令", exact: true }).click();
  checks.push({
    name: "New command opens command input",
    actual: await page.locator(".sender-command-input").count(),
    expected: 1,
  });
  await page.screenshot({ path: resolve(output, "new-command.png") });
  console.log(JSON.stringify({ output, requests, checks }));
  for (const check of checks) assert.deepEqual(check.actual, check.expected, check.name);
} finally {
  if (id) await invoke("close_session", { id });
  await writeFile(resolve(output, "requests.json"), JSON.stringify(requests));
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify({ codexVersion, requests, checks }, null, 2),
  );
  await browser.close();
  server.close();
}
