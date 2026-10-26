import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "selects the exact process family and probes healthy/blocked native windows with a deadline",
  () => {
    const root = path.resolve(".tmp/hang-probe-tests");
    mkdirSync(root, { recursive: true });
    const output = mkdtempSync(path.join(root, "report-"));
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "scripts/fixtures/hang-probe.ps1",
          "-OutputDirectory",
          output,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 25000 },
      );
      expect(result.status, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("hang probe fixture passed");
      expect(readdirSync(output).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    } finally {
      // mkdtemp creates this exact directory within the ignored workspace;
      // no links or user directories are added by the fixture.
      if (path.dirname(output) !== root) throw new Error("Unexpected diagnostic fixture path");
      rmSync(output, { recursive: true, force: true });
    }
  },
  30000,
);
