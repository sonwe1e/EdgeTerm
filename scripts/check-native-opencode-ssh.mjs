// Real OpenCode 2.2.5 over local OpenSSH, in an explicitly selected disposable
// WebView2 instance. The TCP proxy delays server output to reproduce remote echo.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

const output = resolve(process.argv[2] || "");
assert.ok(output.startsWith(resolve(".tmp") + sep));
assert.ok(process.env.EDGETERM_CDP_TARGET_ID);
const remoteEnvironment = process.env.EDGETERM_OPENCODE_ENV;
assert.match(remoteEnvironment || "", /^\/[A-Za-z0-9_./-]+\.sh$/);
await mkdir(output);
const result = {
  checks: [],
  errors: [],
  boundary:
    "Real OpenCode 2.2.5, WSL OpenSSH, packaged WebView2; 200ms downstream latency; no model requests",
};
const sockets = new Set();
const proxy = createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: 22 });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", (error) => {
      result.errors.push(`SSH proxy: ${error.message}`);
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
let page, sessionId;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const poll = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${label}`);
};
let recording;
const raw = async () => (recording ? readFile(recording, "utf8").catch(() => "") : "");
try {
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const cdp = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach();
    if (targetInfo.targetId === process.env.EDGETERM_CDP_TARGET_ID) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()));
  page.on("pageerror", (error) => result.errors.push(String(error)));
  assert.equal(await invoke("portable_mode"), true);
  assert.deepEqual(await invoke("list_sessions"), []);
  assert.deepEqual(await invoke("list_profiles"), []);
  const profile = await invoke("save_profile", {
    profile: {
      name: "OpenCode SSH fixture",
      kind: "ssh",
      host: "127.0.0.1",
      port: proxy.address().port,
      username: "edgeterm",
      auth: "publicKey",
      privateKeyPath: resolve(".tmp/ssh/id_ed25519"),
      record: true,
      recordDir: resolve(output, "recordings"),
    },
  });
  result.profileId = profile.id;
  await page.reload();
  await page.getByText(profile.name, { exact: true }).first().dblclick();
  await poll(async () => {
    const sessions = await invoke("list_sessions");
    if (!sessions.length) return false;
    sessionId = sessions[0].id;
    recording = sessions[0].recording;
    return !!recording;
  }, "SSH connection");
  await poll(async () => /[$#] /.test(await raw()), "shell prompt");
  await invoke("write_session", {
    id: sessionId,
    data: `. ${remoteEnvironment}\r`,
  });
  await poll(
    async () => (await raw()).includes("FIXTURE_READY\r\n"),
    "isolated remote environment",
  );
  result.remoteHome = (await raw()).match(
    /FIXTURE_HOME:(\/tmp\/edgeterm-opencode-225\.[A-Za-z0-9]+)/,
  )?.[1];
  assert.ok(result.remoteHome, "OpenCode home must be isolated on the Linux filesystem");
  await invoke("write_session", { id: sessionId, data: "opencode --version\r" });
  await poll(
    async () => (await raw()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("opencode v2.2.5"),
    "OpenCode 2.2.5 version",
  );
  result.opencodeVersion = "2.2.5";
  await page.waitForTimeout(700);
  const input = page.locator(".xterm-helper-textarea").first();
  await input.focus();
  await page.keyboard.insertText("opencode");
  await page.keyboard.press("Enter");
  const tab = page.locator(`[data-tab-id="${sessionId}"]`);
  await poll(
    async () => /\x1b\]7501;[^\x07\x1b]*state=idle/.test(await raw()),
    "actual OpenCode idle report",
    45000,
  );
  await page.waitForTimeout(1200);
  const initialClass = await tab.getAttribute("class");
  result.idle = { class: initialClass, label: await tab.getAttribute("aria-label") };
  result.statusReports = [...(await raw()).matchAll(/\x1b\]7501;([^\x07\x1b]*)/g)].map((m) => m[1]);
  await page.screenshot({ path: resolve(output, "idle.png") });
  if (process.env.EDGETERM_OPENCODE_EXPECT_BUG === "1") {
    assert.match(initialClass, /is-command-running/, "baseline must reproduce idle animation");
    result.checks.push("Baseline reproduced: real idle report received while tab still running");
  } else {
    assert.match(initialClass, /is-command-idle/, "idle OpenCode must stop the tab animation");
    result.checks.push("Actual initial idle report stops the tab animation despite delayed echo");
    await input.focus();
    await page.keyboard.insertText("draft only, do not submit");
    await page.waitForTimeout(3500);
    assert.match(await tab.getAttribute("class"), /is-command-idle/);
    result.checks.push("Typing an unsubmitted draft remains idle");
    await page.screenshot({ path: resolve(output, "draft-idle.png") });
    await page.keyboard.press("Control+u");
  }
  // Quit the actual TUI without submitting a prompt or contacting any model.
  const exitOffset = (await raw()).length;
  await invoke("write_session", { id: sessionId, data: "\x03" });
  await page.waitForTimeout(200);
  await invoke("write_session", { id: sessionId, data: "\x03" });
  await poll(
    async () => (await raw()).slice(exitOffset).includes("edgeterm@fixture:~/project$ "),
    "OpenCode returns to the shell",
  );
  await page.waitForTimeout(700);
  await input.focus();
  await page.keyboard.insertText("sleep 2");
  await page.keyboard.press("Enter");
  await poll(
    async () => /is-command-running/.test(await tab.getAttribute("class")),
    "ordinary command starts",
  );
  await poll(
    async () => /is-command-idle/.test(await tab.getAttribute("class")),
    "ordinary command finishes",
  );
  result.checks.push("Ordinary shell activity works after OpenCode exits");
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
