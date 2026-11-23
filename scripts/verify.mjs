// One command for the repository's verification gate (engineering standards R1-R4).
//
// Usage: node scripts/verify.mjs [task ...]
//        (default: format:check typecheck lint test test:browser)
//
// Each task runs through the managed runner (scripts/run-task.mjs), one after
// another: the runner allows one managed task at a time, so this never
// overlaps them, and it inherits stdio so a failure is visible where it
// happened. The run stops at the first failing task — a later task is a guess
// once an earlier one failed — and prints every task's exit code either way.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_TASKS = ["format:check", "typecheck", "lint", "test", "test:browser"];

/** One line per task, in the order they ran; a skipped task says so. */
export function summarize(rows) {
  return rows
    .map(({ task, status, ms, ran }) => {
      const verdict = !ran ? "skipped" : status === 0 ? "ok" : `FAILED (${status})`;
      const took = ran ? ` ${(ms / 1000).toFixed(1)}s` : "";
      return `  ${task.padEnd(14)} ${verdict}${took}`;
    })
    .join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const tasks = argv.length > 0 ? argv : DEFAULT_TASKS;
  const rows = [];
  let failed = false;
  for (const task of tasks) {
    if (failed) {
      rows.push({ task, status: 0, ms: 0, ran: false });
      continue;
    }
    const started = Date.now();
    const status = spawnSync(process.execPath, ["scripts/run-task.mjs", task], {
      cwd: root,
      stdio: "inherit",
    }).status;
    rows.push({ task, status: status ?? 1, ms: Date.now() - started, ran: true });
    if (status !== 0) failed = true;
  }
  console.log("\n[edgeterm] verify");
  console.log(summarize(rows));
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
