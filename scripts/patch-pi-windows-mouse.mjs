// Pi 1.4.0 writes fullscreen mouse modes before Windows VT input is enabled.
// Repair both the SDK's TUI module and the bundled TUI used by the npm pi bin.
import assert from "node:assert/strict";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

assert.equal(process.platform, "win32", "This repair is only for native Windows Pi");
assert.ok(process.env.EDGETERM_PI_ROOT, "Set EDGETERM_PI_ROOT to the Pi package directory");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--restore"),
  "Unknown argument",
);
const restore = process.argv.includes("--restore");
const piRoot = resolve(process.env.EDGETERM_PI_ROOT);
const tuiRoot = resolve(piRoot, "node_modules/@earendil-works/pi-tui");
const piPackage = JSON.parse(await readFile(resolve(piRoot, "package.json"), "utf8"));
for (const [pkg, name] of [
  [piPackage, "@earendil-works/pi-coding-agent"],
  [JSON.parse(await readFile(resolve(tuiRoot, "package.json"), "utf8")), "@earendil-works/pi-tui"],
]) {
  assert.equal(pkg.name, name);
  assert.equal(pkg.version, "1.4.0", "Recheck the startup order before patching another version");
}
assert.equal(piPackage.bin?.pi, "dist/bundle/cli.js", "Recheck the installed pi command entry");
const cli = await readFile(resolve(piRoot, piPackage.bin.pi), "utf8");
assert.ok(cli.includes('"./cli-runtime.js"'), "Unexpected bundled CLI loader");
const runtime = await readFile(resolve(piRoot, "dist/bundle/cli-runtime.js"), "utf8");
const chunksRoot = resolve(piRoot, "dist/bundle/chunks");
const bundledClass = "TuiAltScreen=class extends TuiBase{";
const candidates = [];
for (const name of await readdir(chunksRoot)) {
  if (!name.endsWith(".js")) continue;
  const path = resolve(chunksRoot, name);
  const source = await readFile(path, "utf8");
  if (source.includes(bundledClass)) candidates.push({ path, source });
}
assert.equal(candidates.length, 1, "Expected one bundled fullscreen TUI implementation");
const bundled = candidates[0];
assert.ok(
  runtime.includes(`"./chunks/${basename(bundled.path)}"`),
  "The repaired TUI chunk must be imported by the actual CLI runtime",
);
const base = await readFile(resolve(tuiRoot, "dist/tui.js"), "utf8");
assert.ok(
  base.includes(
    "this.beforeTerminalStart();\n        this.terminal.start((data) => this.handleTerminalInput(data), () => this.requestRender());\n        this.afterTerminalStart();",
  ),
  "Unexpected Pi terminal startup order",
);
const marker = "    // EdgeTerm: reissue mouse modes after Windows VT input is enabled.";
const hook = `${marker}
    afterTerminalStart() {
        super.afterTerminalStart();
        if (process.platform !== "win32" || !this.mouseEnabled)
            return;
        const term = process.env.TERM?.toLowerCase() ?? "";
        const buttonMotion = process.env.TMUX !== undefined ||
            process.env.ZELLIJ !== undefined ||
            process.env.STY !== undefined ||
            term.startsWith("tmux") || term.startsWith("screen");
        this.terminal.write(buttonMotion ? ENABLE_BUTTON_MOTION_MOUSE : ENABLE_ALL_MOTION_MOUSE);
    }
`;
const moduleAnchor = "    beforeTerminalStop(_options) {";
function patched(source, bundled) {
  const anchor = bundled ? bundledClass : moduleAnchor;
  assert.equal(source.split(anchor).length, 2, "Unexpected Pi fullscreen implementation");
  if (bundled) {
    assert.ok(source.includes("ENABLE_BUTTON_MOTION_MOUSE="));
    assert.ok(source.includes("ENABLE_ALL_MOTION_MOUSE="));
    assert.ok(
      source.includes(
        "this.beforeTerminalStart(),this.terminal.start(data=>this.handleTerminalInput(data),()=>this.requestRender()),this.afterTerminalStart()",
      ),
      "Unexpected bundled terminal startup order",
    );
    assert.equal(
      source.match(/afterTerminalStart\(\)\{/g)?.length,
      1,
      "Unexpected bundled startup hooks",
    );
    return source.replace(anchor, `${anchor}\n${hook}`);
  }
  assert.ok(!source.includes("afterTerminalStart()"), "Pi already defines a startup hook");
  assert.ok(source.includes("const ENABLE_BUTTON_MOTION_MOUSE ="));
  assert.ok(source.includes("const ENABLE_ALL_MOTION_MOUSE ="));
  return source.replace(anchor, hook + anchor);
}
async function readBackup(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
// Validate every target before writing either one. A changed installation or
// backup must not leave the SDK and the actual CLI only partially repaired.
const plans = [];
for (const [target, isBundled] of [
  [resolve(tuiRoot, "dist/tui-alt-screen.js"), false],
  [bundled.path, true],
]) {
  const current = await readFile(target, "utf8");
  const backup = `${target}.edgeterm-windows-mouse.bak`;
  const original = await readBackup(backup);
  if (current.includes(marker)) {
    assert.notEqual(original, null, `Missing backup for ${target}`);
    assert.equal(current, patched(original, isBundled), `Patch or backup changed: ${target}`);
    plans.push({ target, backup, current, updated: restore ? original : current, restore });
  } else {
    assert.equal(original, null, `Unrecognized existing backup: ${backup}`);
    const updated = patched(current, isBundled);
    plans.push({ target, backup, current, updated: restore ? current : updated, restore: false });
  }
}
for (const plan of plans) {
  if (plan.updated === plan.current) {
    console.log(`${restore ? "Already restored" : "Already repaired"}: ${plan.target}`);
    continue;
  }
  if (!plan.restore) await writeFile(plan.backup, plan.current, { flag: "wx" });
  await writeFile(plan.target, plan.updated);
  if (plan.restore) await unlink(plan.backup);
  console.log(`${plan.restore ? "Restored" : "Repaired"}: ${plan.target}`);
}
