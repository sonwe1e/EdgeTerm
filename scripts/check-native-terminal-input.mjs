// Windows WebView2/ConPTY acceptance with an installed Pi and generated
// conversation only. No model requests, user sessions, or user Pi config.
// Select a disposable portable target explicitly, as in the other native gates.
// Args: <new-output-dir> [resume-hint|default|transcript] [ctrl-d|ctrl-c|quit].
// default/transcript are negative controls: history replay must fail the gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
assert.ok(process.env.EDGETERM_CDP_TARGET_ID, "Select the disposable page explicitly");
assert.ok(
  process.env.EDGETERM_PI_ROOT,
  "Set EDGETERM_PI_ROOT to the installed pi-coding-agent package",
);
assert.ok(process.argv[2], "Pass a fresh output directory under .tmp");
const exitOutput = process.argv[3] || "resume-hint";
const exitMethod = process.argv[4] || "ctrl-d";
assert.ok(["default", "transcript", "resume-hint"].includes(exitOutput), "Unknown exit output");
assert.ok(["ctrl-d", "ctrl-c", "quit"].includes(exitMethod), "Unknown exit method");
assert.ok(process.argv.length <= 5, "Unexpected arguments");
const output = resolve(process.argv[2]);
assert.ok(output.startsWith(resolve(".tmp") + "\\"));
await mkdir(output);
const project = resolve(output, "project");
const agent = resolve(output, "agent");
await mkdir(project);
await mkdir(agent);
const piRoot = resolve(process.env.EDGETERM_PI_ROOT);
const piPackage = JSON.parse(await readFile(resolve(piRoot, "package.json"), "utf8"));
assert.equal(piPackage.name, "@earendil-works/pi-coding-agent");
assert.equal(typeof piPackage.bin?.pi, "string", "Pi must declare its command entry");
const piEntry = resolve(piRoot, piPackage.bin.pi);
assert.ok(piEntry.startsWith(piRoot + "\\"), "Pi command entry must be inside its package");
const tuiChunks = [];
const chunksRoot = resolve(piRoot, "dist/bundle/chunks");
for (const name of await readdir(chunksRoot)) {
  if (!name.endsWith(".js")) continue;
  const source = await readFile(resolve(chunksRoot, name), "utf8");
  if (source.includes("TuiAltScreen=class extends TuiBase{")) tuiChunks.push(source);
}
assert.equal(tuiChunks.length, 1, "Expected one bundled fullscreen TUI implementation");
const piMouseSource = tuiChunks[0];
const now = Date.now();
const timestamp = new Date(now).toISOString();
const entries = [{ type: "session", version: 3, id: randomUUID(), timestamp, cwd: project }];
let parentId = null;
for (let n = 1; n <= 80; n++) {
  const marker = `PI-HISTORY-${String(n).padStart(3, "0")}`;
  for (const role of ["user", "assistant"]) {
    const id = randomUUID().slice(0, 8);
    const message =
      role === "user"
        ? { role, content: `Generated question ${n}`, timestamp: now }
        : {
            role,
            content: [
              {
                type: "text",
                text: Array.from(
                  { length: 8 },
                  (_, line) => `${marker} generated answer line ${line + 1}`,
                ).join("\n"),
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4.1",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: now,
          };
    entries.push({ type: "message", id, parentId, timestamp, message });
    parentId = id;
  }
}
const history = resolve(project, "history.jsonl");
await writeFile(history, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
await writeFile(
  resolve(agent, "settings.json"),
  JSON.stringify({
    quietStartup: true,
    checkForUpdates: false,
    ...(exitOutput === "default" ? {} : { fullscreenExitOutput: exitOutput }),
  }),
);
const exitMarker = `PI-EXIT-COMPLETE-${randomUUID()}`;
const launcher = resolve(project, "launch-pi.cmd");
await writeFile(
  launcher,
  [
    "@echo off",
    `set "PI_CODING_AGENT_DIR=${agent}"`,
    `set "PI_TUI_WRITE_LOG=${resolve(output, "pi-output.ansi")}"`,
    `cd /d "${project}"`,
    `"${process.execPath}" "${piEntry}" --offline --no-approve --no-context-files --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-tools --session "${history}" --tui-mode fullscreen`,
    `echo ${exitMarker}`,
    "",
  ].join("\r\n"),
);

const result = {
  piVersion: piPackage.version,
  piEntry: piPackage.bin.pi,
  exitOutput,
  exitMethod,
  piWindowsMousePatch: piMouseSource.includes(
    "EdgeTerm: reissue mouse modes after Windows VT input is enabled.",
  ),
  errors: [],
  checks: {},
};
const browser = await chromium.connectOverCDP(
  process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9243",
);
const sessions = new Set();
async function poll(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
let page;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const probe = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await probe.send("Target.getTargetInfo");
    await probe.detach();
    if (targetInfo.targetId === process.env.EDGETERM_CDP_TARGET_ID) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()));
  assert.equal(await invoke("portable_mode"), true);
  assert.deepEqual(await invoke("list_sessions"), []);
  assert.deepEqual(await invoke("list_profiles"), []);
  assert.equal(await page.locator(".tab").count(), 0);
  await page.evaluate(() => localStorage.setItem("edgeterm.gpuRenderer", "off"));
  await page.reload();
  await page.locator(".menubar").waitFor();
  page.on("pageerror", (error) => result.errors.push(String(error)));
  result.environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
  }));
  await page.evaluate(() => {
    const original = window.fetch;
    window.__terminalInputWrites = [];
    window.__terminalOutput = [];
    window.__terminalInputWheels = [];
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    const getCallback = callbacks.get;
    callbacks.get = function (id) {
      const callback = getCallback.call(this, id);
      if (!callback) return callback;
      return function (data) {
        if (data?.message instanceof ArrayBuffer)
          window.__terminalOutput.push(Array.from(new Uint8Array(data.message)));
        return callback(data);
      };
    };
    document.addEventListener(
      "wheel",
      (event) =>
        window.__terminalInputWheels.push({ target: event.target.className, deltaY: event.deltaY }),
      true,
    );
    window.fetch = async function (url, options) {
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      if (command === "write_session_bytes")
        window.__terminalInputWrites.push({
          command,
          bytes: Array.from(
            new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength),
          ),
        });
      if (command === "write_session") {
        const args = JSON.parse(options.body);
        if (/^\x1b\[(?:<|M|3;3)/.test(args.data))
          window.__terminalInputWrites.push({ command, data: args.data });
      }
      return original.call(this, url, options);
    };
  });
  const openShell = async () => {
    await page
      .getByText(/^(Local Shell|本地 Shell)$/)
      .first()
      .dblclick();
    const deadline = Date.now() + 30000;
    let added = [];
    while (added.length === 0 && Date.now() < deadline) {
      added = (await invoke("list_sessions")).filter(({ id }) => !sessions.has(id));
      if (!added.length) await page.waitForTimeout(25);
    }
    for (const { id } of added) sessions.add(id);
    assert.equal(added.length, 1);
    await page.locator(".pane-slot:not(.is-hidden) .xterm-helper-textarea").focus();
    return added[0].id;
  };
  const first = await openShell();
  await invoke("write_session", { id: first, data: `"${launcher}"\r` });
  const rows = page.locator(".pane-slot:not(.is-hidden) .xterm-rows");
  await poll(
    async () => (await rows.innerText()).includes("PI-HISTORY-080"),
    "Pi transcript startup",
  );
  const markers = async () => [
    ...new Set(
      [...(await rows.innerText()).matchAll(/PI-HISTORY-(\d+)/g)].map((match) => Number(match[1])),
    ),
  ];
  let bottom = [];
  await poll(async () => {
    bottom = await markers();
    return bottom.includes(80);
  }, "Pi history settled at its latest message");
  await page.waitForTimeout(500);
  result.mouseClass = await page.locator(".pane-slot:not(.is-hidden) .xterm").getAttribute("class");
  await page
    .locator(".pane-slot:not(.is-hidden) .xterm.enable-mouse-events")
    .waitFor({ timeout: 5000 });
  await page.screenshot({ path: resolve(output, "pi-bottom.png") });
  const screen = await page.locator(".pane-slot:not(.is-hidden) .xterm-screen").boundingBox();
  assert.ok(screen);
  await page.mouse.move(screen.x + screen.width * 0.4, screen.y + screen.height * 0.3);
  const turnWheel = async (delta, steps = 12) => {
    for (let step = 0; step < steps; step++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(25);
    }
  };
  await turnWheel(-120);
  await poll(async () => {
    const visible = await markers();
    return visible.length > 0 && Math.max(...visible) < 80;
  }, "Pi wheel scroll to older messages");
  const older = await markers();
  assert.ok(older.length > 0 && Math.max(...older) < 80);
  await turnWheel(-120);
  await poll(async () => {
    const visible = await markers();
    return visible.length > 0 && Math.max(...visible) < Math.max(...older);
  }, "Pi wheel scroll further into history");
  const oldest = await markers();
  assert.ok(oldest.length > 0 && Math.max(...oldest) < Math.max(...older));
  await page.screenshot({ path: resolve(output, "pi-history.png") });
  await turnWheel(120, 24);
  await poll(async () => {
    const visible = await markers();
    return visible.length > 0 && Math.max(...visible) > Math.max(...oldest);
  }, "Pi wheel scroll back to newer messages");
  const newer = await markers();
  assert.ok(newer.length > 0 && Math.max(...newer) > Math.max(...oldest));
  result.checks.scroll = { bottom, older, oldest, newer };
  await page.locator(".pane-slot:not(.is-hidden) .xterm-helper-textarea").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+U");
  await page.keyboard.type("alpha beta gamma");
  await poll(
    async () => (await rows.innerText()).includes("alpha beta gamma"),
    "Pi editor text input",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("Alt+Delete");
  await poll(async () => {
    const text = await rows.innerText();
    return text.includes("beta gamma") && !text.includes("alpha beta gamma");
  }, "Pi Alt+Delete word deletion");
  assert.equal(await page.locator(".menu-dropdown").count(), 0);
  assert.match(await rows.innerText(), /beta gamma/);
  assert.doesNotMatch(await rows.innerText(), /alpha beta gamma/);
  result.checks.altDelete = true;
  await page.screenshot({ path: resolve(output, "pi-alt-delete.png") });
  const second = await openShell();
  await page.keyboard.press("Control+Shift+Tab");
  await page.waitForFunction(
    (id) => document.querySelector(".tab.is-active")?.getAttribute("data-tab-id") === id,
    first,
  );
  await page.keyboard.press("Control+Tab");
  await page.waitForFunction(
    (id) => document.querySelector(".tab.is-active")?.getAttribute("data-tab-id") === id,
    second,
  );
  result.checks.tabs = true;

  // Close Pi normally rather than only killing its entire test session.
  // Its default transcript replay happens after leaving the alternate screen.
  await page.keyboard.press("Control+Shift+Tab");
  await page.waitForFunction(
    (id) => document.querySelector(".tab.is-active")?.getAttribute("data-tab-id") === id,
    first,
  );
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+K");
  await poll(async () => !(await rows.innerText()).includes("beta gamma"), "Pi editor cleared");
  const exitOutputStart = await page.evaluate(() => window.__terminalOutput.length);
  if (exitMethod === "quit") {
    await page.keyboard.type("/quit");
    await page.keyboard.press("Enter");
  } else if (exitMethod === "ctrl-c") {
    await page.keyboard.press("Control+C");
    await page.keyboard.press("Control+C");
  } else {
    await page.keyboard.press("Control+D");
  }
  await poll(async () => (await rows.innerText()).includes(exitMarker), "Pi returned to its shell");
  const sourceOutput = await readFile(resolve(output, "pi-output.ansi"));
  const leaveSequence = Buffer.from("\x1b[?1049l");
  const leaveOffset = sourceOutput.lastIndexOf(leaveSequence);
  assert.ok(leaveOffset >= 0, "Pi must leave the alternate screen");
  const sourceAfterExit = sourceOutput.subarray(leaveOffset + leaveSequence.length);
  const exitChunks = await page.evaluate(
    (start) => window.__terminalOutput.slice(start),
    exitOutputStart,
  );
  const ptyExitOutput = Buffer.from(exitChunks.flat());
  const ptyLeaveOffset = ptyExitOutput.lastIndexOf(leaveSequence);
  assert.ok(ptyLeaveOffset >= 0, "The PTY must restore the normal screen");
  const ptyAfterExit = ptyExitOutput.subarray(ptyLeaveOffset + leaveSequence.length);
  await writeFile(resolve(output, "pi-after-exit.ansi"), sourceAfterExit);
  await writeFile(resolve(output, "pty-exit.ansi"), ptyExitOutput);
  const savedEntries = (await readFile(history, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const savedMessages = savedEntries.filter((entry) => entry.type === "message");
  const mouseClass = await page.locator(".pane-slot:not(.is-hidden) .xterm").getAttribute("class");
  result.checks.exit = {
    sourceBytesAfterAltScreen: sourceAfterExit.length,
    ptyBytesDuringExit: ptyExitOutput.length,
    historyMarkersAfterAltScreen: [...sourceAfterExit.toString("utf8").matchAll(/PI-HISTORY-\d+/g)]
      .length,
    ptyHistoryMarkersAfterAltScreen: [...ptyAfterExit.toString("utf8").matchAll(/PI-HISTORY-\d+/g)]
      .length,
    // The resume hint uses process.stdout directly, outside Pi's TUI write log.
    resumeHint: ptyAfterExit.includes(Buffer.from("--session ")),
    savedMessages: savedMessages.length,
    mouseDisabled: !mouseClass.includes("enable-mouse-events"),
    shellReady: true,
  };
  await page.screenshot({ path: resolve(output, "pi-exited.png") });
  assert.deepEqual(
    savedMessages,
    entries.filter((entry) => entry.type === "message"),
  );
  assert.equal(result.checks.exit.mouseDisabled, true, "Pi must release mouse reporting");
  assert.equal(
    result.checks.exit.historyMarkersAfterAltScreen,
    0,
    "Pi replayed conversation history on exit",
  );
  assert.equal(
    result.checks.exit.ptyHistoryMarkersAfterAltScreen,
    0,
    "History replay reached the normal screen",
  );
  assert.equal(result.checks.exit.resumeHint, true, "Keep a hint for reopening the saved session");
  result.reports = await page.evaluate(() => window.__terminalInputWrites);
  assert.ok(
    result.reports.some(({ bytes, data }) => bytes?.[2] === 77 || data?.startsWith("\x1b[<")),
  );
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (page) {
    result.reports = await page.evaluate(() => window.__terminalInputWrites).catch(() => []);
    result.wheels = await page.evaluate(() => window.__terminalInputWheels).catch(() => []);
    const chunks = (await page.evaluate(() => window.__terminalOutput).catch(() => [])) ?? [];
    await writeFile(resolve(output, "pty-output.ansi"), Buffer.from(chunks.flat()));
    await page.screenshot({ path: resolve(output, "final.png") }).catch(() => {});
    for (const id of sessions) await invoke("close_session", { id }).catch(() => {});
    await page.reload().catch(() => {});
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  await browser.close();
  console.log(
    JSON.stringify(
      { ...result, reports: result.reports?.length, wheels: result.wheels?.length },
      null,
      2,
    ),
  );
}
