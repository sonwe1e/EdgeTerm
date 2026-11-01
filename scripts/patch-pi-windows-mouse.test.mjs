import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const temporary = [];
const suffix = ".edgeterm-windows-mouse.bak";
const baseSource = `class TuiBase {
    constructor(terminal) { this.terminal = terminal; this.mouseEnabled = true; }
    start() {
        this.beforeTerminalStart();
        this.terminal.start((data) => this.handleTerminalInput(data), () => this.requestRender());
        this.afterTerminalStart();
    }
    afterTerminalStart() {}
}`;
const moduleSource = `const ENABLE_BUTTON_MOTION_MOUSE = "button";
const ENABLE_ALL_MOTION_MOUSE = "all";
var TuiAltScreen = class extends TuiBase {
    beforeTerminalStart() { this.terminal.write(ENABLE_ALL_MOTION_MOUSE); }
    beforeTerminalStop(_options) {}
};`;
// Keep the relevant minified shapes from the npm 1.4.0 bundle. The test runs
// the repaired class, rather than merely checking for the repair's marker.
const bundleSource = `var ENABLE_BUTTON_MOTION_MOUSE="button",ENABLE_ALL_MOTION_MOUSE="all";class TuiBase{constructor(terminal){this.terminal=terminal;this.mouseEnabled=true}start(){this.beforeTerminalStart(),this.terminal.start(data=>this.handleTerminalInput(data),()=>this.requestRender()),this.afterTerminalStart()}afterTerminalStart(){}}var TuiAltScreen=class extends TuiBase{beforeTerminalStart(){this.terminal.write(ENABLE_ALL_MOTION_MOUSE)}beforeTerminalStop(_options){}};`;

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "edgeterm-pi-mouse-"));
  temporary.push(root);
  const tui = resolve(root, "node_modules/@earendil-works/pi-tui");
  const bundle = resolve(root, "dist/bundle/chunks/tui.js");
  const module = resolve(tui, "dist/tui-alt-screen.js");
  await mkdir(resolve(tui, "dist"), { recursive: true });
  await mkdir(resolve(root, "dist/bundle/chunks"), { recursive: true });
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.4.0",
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  await writeFile(
    resolve(tui, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "1.4.0" }),
  );
  await writeFile(resolve(root, "dist/bundle/cli.js"), 'load("./cli-runtime.js");');
  await writeFile(resolve(root, "dist/bundle/cli-runtime.js"), 'import "./chunks/tui.js";');
  await writeFile(resolve(tui, "dist/tui.js"), baseSource);
  await writeFile(module, moduleSource);
  await writeFile(bundle, bundleSource);
  const run = (...args) =>
    spawnSync(process.execPath, [resolve("scripts/patch-pi-windows-mouse.mjs"), ...args], {
      env: { ...process.env, EDGETERM_PI_ROOT: root },
      encoding: "utf8",
      windowsHide: true,
    });
  return { root, module, bundle, run };
}

function startupWrites(source, env = {}) {
  const context = { process: { platform: "win32", env } };
  runInNewContext(source, context);
  const writes = [];
  let started = false;
  new context.TuiAltScreen({
    write(text) {
      if (started) writes.push(text);
    },
    start() {
      started = true;
    },
  }).start();
  return writes;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Pi Windows mouse compatibility repair", () => {
  it("repairs the bundled command as well as the SDK and preserves multiplexer mouse modes", async () => {
    const { module, bundle, run } = await fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(startupWrites(await readFile(bundle, "utf8"))).toEqual(["all"]);
    expect(startupWrites(await readFile(bundle, "utf8"), { TMUX: "" })).toEqual(["button"]);
    expect(startupWrites(baseSource + (await readFile(module, "utf8")))).toEqual(["all"]);
  });

  it("is idempotent and restores both original files byte for byte", async () => {
    const { module, bundle, run } = await fixture();
    expect(run().status).toBe(0);
    const firstModule = await readFile(module, "utf8");
    const firstBundle = await readFile(bundle, "utf8");
    expect(run().status).toBe(0);
    expect(await readFile(module, "utf8")).toBe(firstModule);
    expect(await readFile(bundle, "utf8")).toBe(firstBundle);
    expect(run("--restore").status).toBe(0);
    expect(await readFile(module, "utf8")).toBe(moduleSource);
    expect(await readFile(bundle, "utf8")).toBe(bundleSource);
    await expect(readFile(module + suffix)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(bundle + suffix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a previous SDK-only repair without replacing its backup", async () => {
    const { module, bundle, run } = await fixture();
    expect(run().status).toBe(0);
    const moduleBackup = await readFile(module + suffix, "utf8");
    await writeFile(bundle, bundleSource);
    await unlink(bundle + suffix);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(startupWrites(await readFile(bundle, "utf8"))).toEqual(["all"]);
    expect(await readFile(module + suffix, "utf8")).toBe(moduleBackup);
  });

  it("rejects a changed bundle before modifying an unrepaired SDK module", async () => {
    const { module, bundle, run } = await fixture();
    expect(run().status).toBe(0);
    await writeFile(module, moduleSource);
    await unlink(module + suffix);
    await writeFile(bundle, (await readFile(bundle, "utf8")) + "// changed elsewhere");
    expect(run().status).not.toBe(0);
    expect(await readFile(module, "utf8")).toBe(moduleSource);
    await expect(readFile(module + suffix)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
