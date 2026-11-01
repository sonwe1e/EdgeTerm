// Compatibility repair for Pi 1.4.0: fullscreen mouse modes are written before
// ProcessTerminal.start enables Windows VT input, so ConPTY consumes them.
// Reissue those modes from the existing afterTerminalStart lifecycle hook.
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

assert.equal(process.platform, "win32", "This repair is only for native Windows Pi");
assert.ok(process.env.EDGETERM_PI_ROOT, "Set EDGETERM_PI_ROOT to the Pi package directory");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--restore"),
  "Unknown argument",
);
const piRoot = resolve(process.env.EDGETERM_PI_ROOT);
const tuiRoot = resolve(piRoot, "node_modules/@earendil-works/pi-tui");
for (const [root, name] of [
  [piRoot, "@earendil-works/pi-coding-agent"],
  [tuiRoot, "@earendil-works/pi-tui"],
]) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.name, name);
  assert.equal(pkg.version, "1.4.0", "Recheck the startup order before patching another version");
}
const target = resolve(tuiRoot, "dist/tui-alt-screen.js");
const backup = `${target}.edgeterm-windows-mouse.bak`;
const anchor = "    beforeTerminalStop(_options) {";
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
const patched = (source) => {
  assert.equal(source.split(anchor).length, 2, "Unexpected Pi lifecycle implementation");
  assert.ok(!source.includes("afterTerminalStart()"), "Pi already defines a startup hook");
  assert.ok(source.includes("const ENABLE_BUTTON_MOTION_MOUSE ="));
  assert.ok(source.includes("const ENABLE_ALL_MOTION_MOUSE ="));
  return source.replace(anchor, hook + anchor);
};
const current = await readFile(target, "utf8");
if (process.argv.includes("--restore")) {
  const original = await readFile(backup, "utf8");
  assert.equal(current, patched(original), "Pi changed since the repair; leaving it untouched");
  await writeFile(target, original);
  await unlink(backup);
  console.log(`Restored ${target}`);
} else if (current.includes(marker)) {
  assert.equal(current, patched(await readFile(backup, "utf8")), "Patch or backup changed");
  console.log(`Already repaired: ${target}`);
} else {
  // Check the actual ordering too, instead of relying only on the package version.
  const base = await readFile(resolve(tuiRoot, "dist/tui.js"), "utf8");
  assert.ok(
    base.includes(
      "this.beforeTerminalStart();\n        this.terminal.start((data) => this.handleTerminalInput(data), () => this.requestRender());\n        this.afterTerminalStart();",
    ),
    "Unexpected Pi terminal startup order",
  );
  const updated = patched(current);
  await writeFile(backup, current, { flag: "wx" });
  await writeFile(target, updated);
  console.log(`Repaired ${target}\nBackup: ${backup}`);
}
