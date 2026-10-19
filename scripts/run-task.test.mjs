import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { budgetEnvironment, taskCommands } from "./run-task.mjs";

describe("resource-bounded task entry", () => {
  it("limits the effective Vitest runner even without the wrapper", () => {
    // Resolve in Node, outside jsdom's incompatible Uint8Array realm.
    const resolved = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { resolveConfig } from "vitest/node"; const { vitestConfig: c } = await resolveConfig({ config: "vitest.config.ts" }); console.log(JSON.stringify({ maxWorkers: c.maxWorkers, maxConcurrency: c.maxConcurrency, projects: c.projects }));'], { encoding: "utf8", windowsHide: true });
    expect(resolved.status, resolved.stderr).toBe(0);
    const vitestConfig = JSON.parse(resolved.stdout);
    expect(vitestConfig.maxWorkers).toBe(2);
    expect(vitestConfig.maxConcurrency).toBe(2);
    const browser = vitestConfig.projects.find((project) => typeof project === "object" && project.test?.name === "browser");
    expect(browser.test.browser.fileParallelism).toBe(false);
  });

  it("replaces inherited unbounded thread counts without mutating the caller", () => {
    const original = { CARGO_BUILD_JOBS: "24", GOMAXPROCS: "24", NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192", KEEP: "yes" };
    expect(budgetEnvironment(original)).toMatchObject({ CARGO_BUILD_JOBS: "2", RUST_TEST_THREADS: "2", GOMAXPROCS: "2", CMAKE_BUILD_PARALLEL_LEVEL: "2", RAYON_NUM_THREADS: "2", UV_THREADPOOL_SIZE: "2", KEEP: "yes" });
    expect(original.CARGO_BUILD_JOBS).toBe("24");
    expect(budgetEnvironment(original).NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192 --max-old-space-size=3072");
    expect(budgetEnvironment(budgetEnvironment(original))).toEqual(budgetEnvironment(original));
  });

  it("uses local CLIs and carries Cargo's exact selected executable", () => {
    const commands = taskCommands("build", ["--mode", "test"]);
    expect(commands[0][0]).toBe(process.execPath);
    expect(commands[0][1].at(-1)).toBe("--noEmit");
    expect(commands[1][1].slice(-3)).toEqual(["build", "--mode", "test"]);
    expect(taskCommands("cargo", ["check"], "C:/rust/cargo.exe")).toEqual([["C:/rust/cargo.exe", ["check"]]]);
    expect(() => taskCommands("script", ["../escape.mjs"])).toThrow();
  });

  it("preserves literal arguments and failing child exit codes", () => {
    const probe = (args) => spawnSync(process.execPath, ["scripts/run-task.mjs", "script", "scripts/fixtures/tooling-probe.mjs", ...args], { encoding: "utf8", windowsHide: true });
    const result = probe(["two words", "a&b", "$(literal)", 'a"b']);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("PROBE:")).slice(6));
    expect(report.args).toEqual(["two words", "a&b", "$(literal)", 'a"b']);
    expect(report.jobs).toBe("2");
    expect(report.heapLimitMiB).toBeGreaterThanOrEqual(3072);
    // V8 adds young-generation space beyond the 3 GiB old-space budget.
    expect(report.heapLimitMiB).toBeLessThan(3584);
    expect(probe(["--exit"]).status).toBe(7);
  }, 30000);

  it.skipIf(process.platform !== "win32")("inherits CPU affinity and priority, permits hooks, rejects a competing task", () => {
    const result = spawnSync(process.execPath, ["scripts/run-task.mjs", "script", "scripts/fixtures/tooling-probe.mjs", "--exercise-lock"], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("PROBE:")).slice(6));
    expect(report.mask).toBeGreaterThan(0);
    expect(report.mask.toString(2).replaceAll("0", "").length).toBeLessThanOrEqual(4);
    expect(report.priority).toBe("BelowNormal");
    expect(report.nested.status, report.nested.stderr).toBe(0);
    const child = JSON.parse(report.nested.stdout.split("PROBE:")[1]);
    expect(child.mask).toBe(report.mask);
    expect(path.normalize(child.node)).toBe(path.normalize(report.node));
    expect(report.independent.status).toBe(1);
    expect(report.independent.stderr).toContain("Another EdgeTerm task is running");
    expect(report.stale.status).toBe(1);
    expect(report.stale.stderr).toContain("Another EdgeTerm task is running");
  }, 30000);

  it.skipIf(process.platform !== "win32")("bootstraps with an empty caller PATH and rejects an invalid explicit Node", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path" || key === "EDGETERM_NODE") delete env[key];
    }
    env.Path = "";
    const ps = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "dev.ps1", "script", "scripts/fixtures/tooling-probe.mjs"];
    const result = spawnSync(ps, args, { env, encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("PROBE:")).slice(6));
    expect(path.isAbsolute(report.node)).toBe(true);
    const invalid = spawnSync(ps, args, { env: { ...env, EDGETERM_NODE: "Z:/missing-edgeterm-node.exe" }, encoding: "utf8", windowsHide: true });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("EDGETERM_NODE must name an existing absolute node.exe path");
  }, 30000);
});
