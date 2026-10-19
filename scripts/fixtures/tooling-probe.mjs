// Integration fixture: observe actual descendants, not a mocked spawn call.
import { spawnSync } from "node:child_process";
import path from "node:path";
import v8 from "node:v8";

const args = process.argv.slice(2);
if (args.includes("--exit")) process.exit(7);
const report = { node: process.execPath, args, jobs: process.env.CARGO_BUILD_JOBS, heapLimitMiB: v8.getHeapStatistics().heap_size_limit / 1024 ** 2 };
if (process.platform === "win32") {
  const ps = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const observed = spawnSync(ps, ["-NoProfile", "-Command", "$p = [Diagnostics.Process]::GetCurrentProcess(); @{ mask = $p.ProcessorAffinity.ToInt64(); priority = $p.PriorityClass.ToString() } | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  if (observed.status !== 0) throw new Error(observed.stderr);
  Object.assign(report, JSON.parse(observed.stdout));
  if (args.includes("--exercise-lock")) {
    const command = ["scripts/run-task.mjs", "script", "scripts/fixtures/tooling-probe.mjs", "--child"];
    const nested = spawnSync(process.execPath, command, { encoding: "utf8", windowsHide: true });
    const independentEnv = { ...process.env };
    delete independentEnv.EDGETERM_TASK_OWNER;
    delete independentEnv.EDGETERM_TASK_ROOT;
    const independent = spawnSync(process.execPath, command, { encoding: "utf8", env: independentEnv, windowsHide: true });
    const stale = spawnSync(process.execPath, command, { encoding: "utf8", env: { ...process.env, EDGETERM_TASK_OWNER_START: "0" }, windowsHide: true });
    report.nested = { status: nested.status, stdout: nested.stdout, stderr: nested.stderr };
    report.independent = { status: independent.status, stderr: independent.stderr };
    report.stale = { status: stale.status, stderr: stale.stderr };
  }
}
console.log(`PROBE:${JSON.stringify(report)}`);
