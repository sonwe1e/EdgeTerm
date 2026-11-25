// One command for the repository's verification gate (engineering standards R1-R4).
//
// Usage: node scripts/verify.mjs [task ...]
//        node scripts/verify.mjs --changed [--since <git-ref>]
//        (default: format:check typecheck lint test test:browser)
//
// When invoked on Windows outside the managed task runner, this script re-enters
// through `scripts/run-task.mjs verify ...` once so all subtasks share one
// PowerShell bootstrap, CPU affinity mask, below-normal priority and mutex
// instead of paying five separate runner launches.
//
// `--changed` is an inner-loop fast pre-check: it always runs format:check,
// typecheck and lint, skips jsdom/browser tests when only docs/ changed, and
// otherwise resolves affected unit/browser test files via a fast static reverse
// import graph (passing explicit test files to Vitest instead of Vitest's slow
// full-graph `related` crawl). Full final gates keep the default all-tasks run.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetEnvironment, taskCommands } from "./run-task.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_TASKS = ["format:check", "typecheck", "lint", "test", "test:browser"];
export const FAST_TRIO = ["format:check", "typecheck", "lint"];

const SOURCE_EXTS = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".css"];
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".mjs", ".js", ".cjs", "/index.ts", "/index.tsx"];
const IGNORED_DIRS = new Set([
  "node_modules",
  ".tmp",
  "dist",
  "artifacts",
  "__screenshots__",
  "target",
]);

/** Parse CLI arguments into explicit tasks or `--changed` mode. */
export function parseVerifyArgs(argv = []) {
  let changed = false;
  let since = null;
  const tasks = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--changed") {
      changed = true;
    } else if (arg === "--since") {
      const ref = argv[i + 1];
      if (!ref || ref.startsWith("-")) throw new Error("--since requires a git ref");
      since = ref;
      changed = true;
      i++;
    } else if (arg.startsWith("--since=")) {
      const ref = arg.slice("--since=".length).trim();
      if (!ref) throw new Error("--since requires a git ref");
      since = ref;
      changed = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown verify option: ${arg}`);
    } else {
      tasks.push(arg);
    }
  }
  return { changed, since, tasks };
}

const isUnitTest = (file) =>
  (file.startsWith("src/") && file.endsWith(".test.ts") && !file.endsWith(".browser.test.ts")) ||
  (file.startsWith("scripts/") && file.endsWith(".test.mjs"));

const isBrowserTest = (file) => file.startsWith("src/") && file.endsWith(".browser.test.ts");

function walkSourceFiles(baseRoot) {
  const found = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
        found.push(rel);
      }
    }
  };
  for (const top of ["src", "scripts"]) {
    const absTop = path.join(baseRoot, top);
    if (existsSync(absTop) && statSync(absTop).isDirectory()) visit(absTop, top);
  }
  return found;
}

/** Extract relative import specifiers from a JS/TS/CSS source file. */
export function extractRelativeImports(source, isCss = false) {
  const specs = new Set();
  const patterns = isCss
    ? [/@import\s+["'](\.[^"']+)["']/g]
    : [
        /\b(?:from|import)\s+["'](\.[^"']+)["']/g,
        /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
        /\bvi\.mock\s*\(\s*["'](\.[^"']+)["']/g,
      ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const clean = match[1].split("?", 1)[0];
      if (clean) specs.add(clean);
    }
  }
  return [...specs];
}

function resolveRelative(fromFile, spec, knownFiles) {
  const dir = path.posix.dirname(fromFile);
  const raw = path.posix.normalize(path.posix.join(dir, spec));
  for (const suffix of RESOLVE_EXTS) {
    const candidate = `${raw}${suffix}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve affected unit and browser test files from a list of changed paths
 * using a fast static reverse-import BFS. CSS changes always include
 * `src/colourLiterals.test.ts` (glob-imported) and skip propagating through the
 * barrel `src/styles.css` so inner-loop CSS iteration stays fast; full
 * `npm run verify` still runs every browser test.
 */
export function resolveAffectedTests(changedFiles, baseRoot = root) {
  const allFiles = walkSourceFiles(baseRoot);
  const known = new Set(allFiles);
  const reverse = new Map();
  for (const file of allFiles) {
    let text;
    try {
      text = readFileSync(path.join(baseRoot, file), "utf8");
    } catch {
      continue;
    }
    const isCss = file.endsWith(".css");
    for (const spec of extractRelativeImports(text, isCss)) {
      const target = resolveRelative(file, spec, known);
      if (!target) continue;
      // Avoid fanning stylesheet-only edits through component imports into
      // App.tsx and dozens of browser suites during inner-loop `--changed`
      // checks; CSS edits explicitly enqueue the token and visual audit suites.
      if (
        target.endsWith(".css") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".browser.test.ts")
      ) {
        continue;
      }
      let importers = reverse.get(target);
      if (!importers) {
        importers = new Set();
        reverse.set(target, importers);
      }
      importers.add(file);
    }
  }

  const visited = new Set();
  const queue = [];
  const enqueue = (file) => {
    if (!visited.has(file)) {
      visited.add(file);
      queue.push(file);
    }
  };

  for (const file of changedFiles) {
    enqueue(file);
    if (file.endsWith(".css")) {
      if (known.has("src/colourLiterals.test.ts")) enqueue("src/colourLiterals.test.ts");
      if (known.has("src/test/uiAudit.browser.test.ts")) {
        enqueue("src/test/uiAudit.browser.test.ts");
      }
    }
    // Also match colocated *.test.ts / *.test.mjs if a file is imported indirectly
    // or tested via raw string/fs reads (e.g. CSS row-height tests).
    if (
      file === "src/styles/transfer.styles.css" &&
      known.has("src/components/TransferCenter.rowHeight.test.ts")
    ) {
      enqueue("src/components/TransferCenter.rowHeight.test.ts");
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const importers = reverse.get(current);
    if (!importers) continue;
    for (const importer of importers) enqueue(importer);
  }

  const unit = [...visited].filter(isUnitTest).sort();
  const browser = [...visited].filter(isBrowserTest).sort();
  return { unit, browser };
}

/**
 * Decide whether a changed file list is empty, docs-only, or touches testable code.
 */
export function planChangedRun(files) {
  const normalized = [
    ...new Set(
      files
        .map((file) => String(file).trim().replaceAll("\\", "/"))
        .filter((file) => file.length > 0),
    ),
  ];
  if (normalized.length === 0) {
    return { empty: true, docsOnly: false, codeFiles: [] };
  }
  const isDocOnly = (file) =>
    file.startsWith("docs/") || file.endsWith(".md") || file === "AGENTS.md";
  const codeFiles = normalized.filter((file) => !isDocOnly(file));
  if (codeFiles.length === 0) {
    return { empty: false, docsOnly: true, codeFiles: [] };
  }
  return { empty: false, docsOnly: false, codeFiles };
}

/** Collect repo-relative changed/untracked paths from git. */
export function gitChangedFiles(since = null) {
  const files = new Set();
  const collect = (args, strictLabel = null) => {
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (res.status !== 0) {
      if (strictLabel) {
        const detail = (res.stderr || res.stdout || "").trim();
        throw new Error(`invalid ${strictLabel}: ${detail || `git exited ${res.status}`}`);
      }
      return;
    }
    for (const line of (res.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  };
  if (since) {
    collect(["diff", "--name-only", `${since}..HEAD`], `--since ref "${since}"`);
  }
  collect(["diff", "--name-only"]);
  collect(["diff", "--name-only", "--cached"]);
  collect(["ls-files", "--others", "--exclude-standard"]);
  return [...files];
}

/** One line per task, in the order they ran; a skipped task says so. */
export function summarize(rows) {
  return rows
    .map(({ task, status, ms, ran, note }) => {
      const verdict = !ran
        ? note
          ? `skipped (${note})`
          : "skipped"
        : status === 0
          ? note
            ? `ok (${note})`
            : "ok"
          : `FAILED (${status})`;
      const took = ran ? ` ${(ms / 1000).toFixed(1)}s` : "";
      return `  ${task.padEnd(14)} ${verdict}${took}`;
    })
    .join("\n");
}

function runSubtask(task, args, env) {
  const commands = taskCommands(task, args, env.EDGETERM_CARGO || "cargo");
  for (const [command, commandArgs] of commands) {
    const result = spawnSync(command, commandArgs, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  // When invoked directly on Windows (outside `run-task.mjs`), re-enter once
  // through `run-task.mjs verify` so the entire sequence shares one managed
  // Windows budget instead of five separate PowerShell launches.
  if (process.platform === "win32" && !process.env.EDGETERM_TASK_OWNER) {
    const forwarded = spawnSync(
      process.execPath,
      [path.join(root, "scripts/run-task.mjs"), "verify", ...argv],
      { cwd: root, stdio: "inherit", windowsHide: true },
    );
    return forwarded.status ?? 1;
  }

  const parsed = parseVerifyArgs(argv);
  const env = budgetEnvironment(process.env);
  const rows = [];
  let failed = false;

  const execStep = (label, task, args = [], note = undefined) => {
    if (failed) {
      rows.push({ task: label, status: 0, ms: 0, ran: false });
      return;
    }
    const started = Date.now();
    const status = runSubtask(task, args, env);
    rows.push({ task: label, status, ms: Date.now() - started, ran: true, note });
    if (status !== 0) failed = true;
  };

  if (parsed.changed) {
    const changedFiles = gitChangedFiles(parsed.since);
    const plan = planChangedRun(changedFiles);
    const affected =
      plan.empty || plan.docsOnly
        ? { unit: [], browser: [] }
        : resolveAffectedTests(plan.codeFiles);
    const baseTasks = parsed.tasks.length > 0 ? parsed.tasks : DEFAULT_TASKS;
    for (const task of baseTasks) {
      if (task === "test" || task === "test:browser") {
        if (failed) {
          rows.push({ task, status: 0, ms: 0, ran: false });
          continue;
        }
        if (plan.empty) {
          rows.push({ task, status: 0, ms: 0, ran: false, note: "no changes" });
          continue;
        }
        if (plan.docsOnly) {
          rows.push({ task, status: 0, ms: 0, ran: false, note: "docs-only" });
          continue;
        }
        const targets = task === "test" ? affected.unit : affected.browser;
        if (targets.length === 0) {
          rows.push({ task, status: 0, ms: 0, ran: false, note: "no affected tests" });
          continue;
        }
        execStep(task, task, targets, `${targets.length} file${targets.length === 1 ? "" : "s"}`);
      } else {
        execStep(task, task);
      }
    }
  } else {
    const tasks = parsed.tasks.length > 0 ? parsed.tasks : DEFAULT_TASKS;
    for (const task of tasks) execStep(task, task);
  }

  const totalMs = rows.reduce((sum, row) => sum + (row.ran ? row.ms : 0), 0);
  console.log(
    `\n[edgeterm] verify${parsed.changed ? " --changed" : ""} (${(totalMs / 1000).toFixed(1)}s)`,
  );
  console.log(summarize(rows));
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
