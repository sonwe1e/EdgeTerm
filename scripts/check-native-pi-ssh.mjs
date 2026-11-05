// Real Pi in a dedicated local SSH account; generated history, no model calls.
// A fixture helper deliberately disables/restores terminal mouse reporting.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const run = promisify(execFile);
const output = resolve(process.argv[2] || "");
assert.ok(output.startsWith(resolve(".tmp") + sep));
assert.ok(process.env.EDGETERM_CDP_TARGET_ID);
const setup = process.env.EDGETERM_PI_SSH_ENV;
const control = process.env.EDGETERM_PI_SSH_CONTROL;
assert.match(setup || "", /^\/[A-Za-z0-9_./-]+\.sh$/);
assert.match(control || "", /^\/[A-Za-z0-9_./-]+\.py$/);
await mkdir(output);
const result = {
  checks: [],
  errors: [],
  boundary:
    "Real Pi 1.5.0 + local OpenSSH + release WebView2; generated messages, 200ms downstream delay, deliberate mouse-mode loss; no model calls",
};
const sockets = new Set();
const proxy = createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: 22 });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", (error) => {
      result.errors.push(error.message);
      client.destroy();
      upstream.destroy();
    });
    socket.on("close", () => sockets.delete(socket));
  }
  client.pipe(upstream);
  upstream.on("data", (chunk) =>
    setTimeout(() => {
      if (!client.destroyed) client.write(chunk);
    }, 200),
  );
  upstream.on("end", () => setTimeout(() => client.end(), 220));
});
await new Promise((done) => proxy.listen(22625, "127.0.0.1", done));
const browser = await chromium.connectOverCDP(process.env.EDGETERM_CDP_URL);
let page, sessionId, recording;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const poll = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 80));
  }
  throw new Error(`Timeout: ${label}`);
};
const raw = async () => (recording ? readFile(recording, "utf8").catch(() => "") : "");
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
  await page.evaluate(() => localStorage.setItem("edgeterm.gpuRenderer", "off"));
  const profile = await invoke("save_profile", {
    profile: {
      name: "Pi SSH fixture",
      kind: "ssh",
      host: "127.0.0.1",
      port: 22625,
      username: "edgeterm",
      auth: "publicKey",
      privateKeyPath: resolve(".tmp/ssh/id_ed25519"),
      record: true,
      recordDir: resolve(output, "recordings"),
    },
  });
  await page.reload();
  page.on("pageerror", (error) => result.errors.push(String(error)));
  await page.evaluate(() => {
    const original = window.fetch;
    window.__piWheelWrites = [];
    window.fetch = async function (url, options) {
      if (decodeURIComponent(new URL(url).pathname.slice(1)) === "write_session") {
        const args = JSON.parse(options.body);
        if (/^\x1b(?:\[|O)/.test(args.data)) window.__piWheelWrites.push(args.data);
      }
      return original.call(this, url, options);
    };
  });
  await page.getByText(profile.name, { exact: true }).first().dblclick();
  await poll(async () => {
    const sessions = await invoke("list_sessions");
    sessionId = sessions[0]?.id;
    recording = sessions[0]?.recording;
    return !!recording;
  }, "SSH connection");
  await poll(async () => /[$#] /.test(await raw()), "shell prompt");
  await invoke("write_session", { id: sessionId, data: `. ${setup}\r` });
  await poll(async () => (await raw()).includes("FIXTURE_READY\r\n"), "isolated Pi fixture");
  result.remoteHome = (await raw()).match(
    /FIXTURE_HOME:(\/tmp\/edgeterm-pi-ssh\.[A-Za-z0-9]+)/,
  )?.[1];
  assert.ok(result.remoteHome);
  await invoke("write_session", { id: sessionId, data: "pi --version\r" });
  await poll(
    async () => (await raw()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("1.5.0"),
    "Pi version",
  );
  result.piVersion = "1.5.0";
  await page.waitForTimeout(650);
  const input = page.locator(".pane-slot:not(.is-hidden) .xterm-helper-textarea");
  const rows = page.locator(".pane-slot:not(.is-hidden) .xterm-rows");
  const terminal = page.locator(".pane-slot:not(.is-hidden) .xterm");
  await input.focus();
  await page.keyboard.insertText("pi");
  await page.keyboard.press("Enter");
  await poll(async () => (await rows.innerText()).includes("PI-HISTORY-080"), "Pi history startup");
  await poll(
    async () => /enable-mouse-events/.test(await terminal.getAttribute("class")),
    "Pi mouse reporting",
  );
  const markers = async () => [
    ...new Set(
      [...(await rows.innerText()).matchAll(/PI-HISTORY-(\d+)/g)].map((m) => Number(m[1])),
    ),
  ];
  const screen = await page.locator(".pane-slot:not(.is-hidden) .xterm-screen").boundingBox();
  assert.ok(screen);
  const wheel = async (delta, count = 4) => {
    await page.mouse.move(screen.x + screen.width * 0.4, screen.y + screen.height * 0.3);
    for (let i = 0; i < count; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
  };
  await wheel(-120, 12);
  await poll(async () => {
    const visible = await markers();
    return visible.length > 0 && Math.max(...visible) < 80;
  }, "normal SGR scrolling");
  result.checks.push("Actual Pi scrolls older history with SGR mouse reports");
  await input.focus();
  await page.keyboard.press("Control+End");
  await poll(async () => (await markers()).includes(80), "return to latest history");
  const draft = "DRAFT_PRESERVE_PI_WHEEL";
  await page.keyboard.insertText(draft);
  await poll(async () => (await rows.innerText()).includes(draft), "draft input");
  await page.screenshot({ path: resolve(output, "before-mode-loss.png") });
  const changeMode = async (mode) => {
    await run(
      "wsl.exe",
      ["-d", "Ubuntu-26.04", "-u", "edgeterm", "--", "python3", control, result.remoteHome, mode],
      { windowsHide: true, timeout: 15000 },
    );
    await poll(
      async () =>
        /enable-mouse-events/.test(await terminal.getAttribute("class")) === (mode === "enable"),
      `mouse ${mode}`,
    );
  };
  await changeMode("disable");
  await page.evaluate(() => {
    window.__piWheelWrites = [];
  });
  await wheel(-120);
  const afterText = await rows.innerText();
  result.afterLoss = {
    markers: await markers(),
    draftPreserved: afterText.includes(draft),
    writes: await page.evaluate(() => window.__piWheelWrites),
  };
  assert.ok(result.afterLoss.markers.length > 0);
  await page.screenshot({ path: resolve(output, "after-mode-loss.png") });
  const before = process.env.EDGETERM_PI_EXPECT_BUG === "1";
  if (before) {
    assert.ok(result.afterLoss.writes.some((data) => /^\x1b(?:\[|O)A$/.test(data)));
    assert.equal(result.afterLoss.draftPreserved, false);
    assert.ok(result.afterLoss.markers.includes(80));
    result.checks.push(
      "Baseline reproduced: wheel sends arrows, changes draft and leaves transcript at latest message",
    );
  } else {
    assert.ok(result.afterLoss.writes.length > 0);
    assert.ok(result.afterLoss.writes.every((data) => data === "\x1b[5~"));
    assert.equal(result.afterLoss.draftPreserved, true);
    assert.ok(Math.max(...result.afterLoss.markers) < 80);
    await page.evaluate(() => {
      window.__piWheelWrites = [];
    });
    await wheel(120);
    assert.ok(Math.max(...(await markers())) > Math.max(...result.afterLoss.markers));
    assert.ok((await rows.innerText()).includes(draft));
    result.checks.push(
      "Missing mouse reports: wheel pages history both ways and preserves the draft",
    );
  }
  await changeMode("enable");
  await page.evaluate(() => {
    window.__piWheelWrites = [];
  });
  await wheel(-120);
  assert.ok(
    (await page.evaluate(() => window.__piWheelWrites)).some((data) => /^\x1b\[<64;/.test(data)),
  );
  result.checks.push("Restored mouse reporting resumes ordinary SGR wheel events");
  await input.focus();
  // Prompt-history navigation can leave the caret at column zero. Clear
  // the entire line before using Pi's explicit, local quit command.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+K");
  await page.keyboard.insertText("/quit");
  await page.keyboard.press("Enter");
  await poll(
    async () => !/enable-mouse-events/.test(await terminal.getAttribute("class")),
    "Pi exit",
  );
  await poll(
    async () => (await rows.innerText()).includes("edgeterm@fixture:~/pi-project$"),
    "shell after Pi exit",
  );
  result.checks.push("Pi exit releases mouse reporting");
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.failure = String(error?.stack || error);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page && sessionId) await invoke("close_session", { id: sessionId }).catch(() => {});
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
