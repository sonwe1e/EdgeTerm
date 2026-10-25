// Commit-range checker for engineering standards R8-R10.
//
// Usage: node scripts/check-commits.mjs [<base>..<head>] [--typecheck] [--lint] [--json]
//                                       [--include-merges] [--clean-stale]
//
// Default range: $(git merge-base main HEAD)..HEAD. Lints every commit
// (oldest first) and, with --typecheck, runs the repo's own TypeScript
// against each commit in a temporary git worktree under .tmp/commit-check/.
// The worktree sits inside the repo so module resolution walks up to the
// main checkout's node_modules; node_modules is never linked or copied.
// Exit code: 0 clean or warnings only, 1 any ERROR, 2 usage/git failure.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED_PREFIXES = ["feat", "fix", "perf", "docs", "chore"];
export const MAX_SUBJECT = 72;

// Heuristic thresholds (warn-only). Lock files are excluded from line counts.
export const LIMITS = { changedLines: 1500, files: 40 };
const IGNORED_FOR_SIZE = [/(^|\/)package-lock\.json$/, /(^|\/)Cargo\.lock$/];

// Absolute or unprovable words in a subject. Word-bounded for English.
export const OVERCLAIM_WORDS = [
  "all",
  "every",
  "entire",
  "entirely",
  "whole",
  "fully",
  "completely",
  "always",
  "never",
  "reliable",
  "robust",
  "seamless",
  "guarantee",
  "guaranteed",
  "guarantees",
  "eliminate",
  "eliminates",
];
export const OVERCLAIM_WORDS_ZH = [
  "全部",
  "所有",
  "彻底",
  "完全",
  "已解决",
  "根治",
  "永不",
  "一劳永逸",
];

const QUANT_CLAIM = /\b\d+(\.\d+)?\s*(x|×|%|ms|s|fps|倍)(?![a-z])|\b\d+(\.\d+)?\s*倍/i;

/** Split a raw commit message into subject, body and `Key: value` lines. */
export function parseMessage(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const subject = (lines[0] ?? "").trim();
  const body = lines.slice(1).join("\n").trim();
  const fields = {};
  for (const line of body.split("\n")) {
    const m = /^([A-Z][A-Za-z-]*):\s?(.*)$/.exec(line.trim());
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  const pm = /^([a-z]+)(\([^)]*\))?(!)?:\s+\S/.exec(subject);
  return { subject, body, fields, prefix: pm ? pm[1] : null, scoped: !!(pm && pm[2]) };
}

/** Overclaim words found in `text` (subject), lower-cased, de-duplicated. */
export function findOverclaims(text) {
  const found = new Set();
  for (const w of OVERCLAIM_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text)) found.add(w);
  }
  for (const w of OVERCLAIM_WORDS_ZH) if (text.includes(w)) found.add(w);
  return [...found];
}

const item = (level, rule, message) => ({ level, rule, message });

/** Message rules (R9). `commit` = { subject, body } or { message }. */
export function lintMessage(commit) {
  const msg =
    commit.message !== undefined
      ? parseMessage(commit.message)
      : parseMessage(`${commit.subject ?? ""}\n\n${commit.body ?? ""}`);
  const out = [];
  const { subject, fields, prefix } = msg;

  if (!prefix || !ALLOWED_PREFIXES.includes(prefix) || msg.scoped) {
    out.push(
      item(
        "ERROR",
        "prefix",
        `subject must start with one of ${ALLOWED_PREFIXES.map((p) => p + ":").join(" ")} (no scope)`,
      ),
    );
  }
  if (subject.length > MAX_SUBJECT) {
    out.push(
      item("ERROR", "subject-length", `subject is ${subject.length} chars (max ${MAX_SUBJECT})`),
    );
  }

  if (prefix === "perf") {
    const measured = fields.Measured;
    const unmeasured = fields.Unmeasured;
    if (measured === undefined && unmeasured === undefined) {
      out.push(
        item(
          "ERROR",
          "perf-evidence",
          "perf: needs a `Measured: baseline … / candidate … / env …` line or an explicit `Unmeasured: <reason>` line",
        ),
      );
    } else if (measured !== undefined) {
      if (!measured || !/baseline/i.test(measured) || !/candidate/i.test(measured)) {
        out.push(
          item(
            "WARN",
            "perf-evidence",
            "Measured: should name baseline, candidate and environment",
          ),
        );
      }
    } else {
      if (!unmeasured) out.push(item("ERROR", "perf-evidence", "Unmeasured: needs a reason"));
      if (QUANT_CLAIM.test(subject)) {
        out.push(
          item(
            "ERROR",
            "perf-evidence",
            "Unmeasured perf commit makes a quantitative claim in the subject",
          ),
        );
      }
    }
  }

  if (prefix === "fix") {
    const tests = fields.Tests;
    if (tests === undefined) {
      out.push(
        item(
          "ERROR",
          "fix-tests",
          "fix: needs `Tests: <regression test, shown failing on old code>` or `Tests: none — <reason>`",
        ),
      );
    } else if (/^none\b/i.test(tests) && !/^none\s*[—–:-]+\s*\S/i.test(tests)) {
      out.push(
        item("ERROR", "fix-tests", "`Tests: none` must give a reason (`Tests: none — <reason>`)"),
      );
    } else if (!tests) {
      out.push(item("ERROR", "fix-tests", "Tests: line is empty"));
    }
  }

  const words = findOverclaims(subject);
  if (words.length) {
    out.push(
      item(
        "WARN",
        "overclaim",
        `subject uses absolute wording (${words.join(", ")}); keep it only if the diff proves it`,
      ),
    );
  }
  if (/\baddress(es|ed)?\b.*\breview\b|评审|review (fix|feedback)/i.test(subject)) {
    out.push(
      item(
        "WARN",
        "review-followup",
        "review follow-up commit: must be re-reviewed against each item, not by title",
      ),
    );
  }
  return out;
}

/** Parse `git show --numstat` output into {path, added, deleted, binary}. */
export function parseNumstat(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    rows.push({
      path: normalizeRenamePath(m[3]),
      added: m[1] === "-" ? 0 : Number(m[1]),
      deleted: m[2] === "-" ? 0 : Number(m[2]),
      binary: m[1] === "-",
    });
  }
  return rows;
}

// numstat prints renames as `a/{x => y}/b` or `x => y`; keep the new path.
function normalizeRenamePath(p) {
  if (p.includes("{") && p.includes(" => ")) {
    return p.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/\/\//g, "/");
  }
  if (p.includes(" => ")) return p.split(" => ")[1];
  return p;
}

/** Parse `git show --name-status -M` into {status, path, from?}. */
export function parseNameStatus(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    if ((status === "R" || status === "C") && parts.length >= 3) {
      rows.push({ status, from: parts[1], path: parts[2] });
    } else if (parts.length >= 2) {
      rows.push({ status, path: parts[1] });
    }
  }
  return rows;
}

const area = (p) =>
  p.startsWith("src-tauri/")
    ? "backend"
    : p.startsWith("src/")
      ? "frontend"
      : p.startsWith("docs/") || /(^|\/)README[^/]*\.md$/i.test(p) || p === "AGENTS.md"
        ? "docs"
        : "other";

/**
 * Scope heuristics (R8), warn-only. `commit` = { subject, body, numstat,
 * nameStatus } with parsed rows. `typecheck` tells whether the delete/rename
 * hint is redundant.
 */
export function scopeHeuristics(commit, { typecheck = false } = {}) {
  const out = [];
  const msg = parseMessage(`${commit.subject ?? ""}\n\n${commit.body ?? ""}`);
  const numstat = commit.numstat ?? [];
  const names = commit.nameStatus ?? [];
  const counted = numstat.filter((r) => !IGNORED_FOR_SIZE.some((re) => re.test(r.path)));
  const lines = counted.reduce((n, r) => n + r.added + r.deleted, 0);
  const files = numstat.length;
  const hasScope = msg.fields.Scope !== undefined && msg.fields.Scope.length > 0;

  if (!hasScope && (lines > LIMITS.changedLines || files > LIMITS.files)) {
    out.push(
      item(
        "WARN",
        "size",
        `${lines} changed lines in ${files} files (limits ${LIMITS.changedLines}/${LIMITS.files}); split it or add a \`Scope:\` line explaining why it cannot be split`,
      ),
    );
  }
  const areas = new Set(numstat.map((r) => area(r.path)));
  if (!hasScope && areas.has("frontend") && areas.has("backend") && areas.has("docs")) {
    out.push(
      item("WARN", "areas", "touches src/, src-tauri/ and docs together; check it is one concern"),
    );
  }
  if (msg.prefix === "docs") {
    const code = numstat.filter((r) => area(r.path) === "frontend" || area(r.path) === "backend");
    if (code.length)
      out.push(
        item(
          "WARN",
          "docs-with-code",
          `docs: commit changes code (${code[0].path}${code.length > 1 ? ", …" : ""})`,
        ),
      );
  }
  // \b does not work after CJK characters, so the Chinese openers are separate.
  if (
    /^(also|additionally|plus)\b/im.test(msg.body) ||
    /^(另外|顺带|顺便|同时还)/m.test(msg.body)
  ) {
    out.push(
      item(
        "WARN",
        "second-concern",
        'body discloses a second concern ("Also …"); split it out or justify with `Scope:`',
      ),
    );
  }
  if (!typecheck) {
    const gone = names.filter(
      (r) => (r.status === "D" || r.status === "R") && /\.(m?[jt]sx?)$/.test(r.from ?? r.path),
    );
    if (gone.length) {
      out.push(
        item(
          "INFO",
          "moved-source",
          `deletes/renames ${gone.map((r) => r.from ?? r.path).join(", ")}; run with --typecheck to prove importers changed in the same commit`,
        ),
      );
    }
  }
  return out;
}

/** Summarise tsc output: error count and first lines. */
export function summarizeTsc(output, max = 5) {
  const errors = String(output)
    .split(/\r?\n/)
    .filter((l) => /error TS\d+/.test(l))
    .map((l) => l.trim());
  return { count: errors.length, first: errors.slice(0, max) };
}

/** Parse CLI arguments. Throws on unknown flags. */
export function parseArgs(argv) {
  const opts = {
    range: null,
    typecheck: false,
    lint: false,
    json: false,
    includeMerges: false,
    cleanStale: false,
  };
  for (const a of argv) {
    if (a === "--typecheck") opts.typecheck = true;
    else if (a === "--lint") opts.lint = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--include-merges") opts.includeMerges = true;
    else if (a === "--clean-stale") opts.cleanStale = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (opts.range) throw new Error(`unexpected argument ${a}`);
    else opts.range = a;
  }
  if (opts.range && !/^[^.\s]+\.\.[^.\s]+$/.test(opts.range)) {
    throw new Error(`range must be <base>..<head>, got ${opts.range}`);
  }
  return opts;
}

// ---- git side --------------------------------------------------------------

function git(args, cwd, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

function defaultRange(root) {
  for (const main of ["main", "origin/main"]) {
    const r = git(["merge-base", main, "HEAD"], root, true);
    if (r.status === 0 && r.stdout.trim()) return `${r.stdout.trim()}..HEAD`;
  }
  throw new Error("no range given and no merge-base with main/origin/main; pass <base>..<head>");
}

function listCommits(root, range, includeMerges) {
  const args = ["rev-list", "--reverse", "--topo-order"];
  if (!includeMerges) args.push("--no-merges");
  args.push(range);
  return git(args, root).stdout.split(/\r?\n/).filter(Boolean);
}

function readCommit(root, sha) {
  const meta = git(["show", "-s", "--format=%h%x00%P%x00%B", sha], root).stdout;
  const [short, parents, message] = meta.split("\0");
  const msg = parseMessage(message);
  const numstat = parseNumstat(git(["show", "--numstat", "-M", "--format=", sha], root).stdout);
  const nameStatus = parseNameStatus(
    git(["show", "--name-status", "-M", "--format=", sha], root).stdout,
  );
  return {
    sha,
    short,
    merge: parents.trim().split(/\s+/).length > 1,
    subject: msg.subject,
    body: msg.body,
    numstat,
    nameStatus,
  };
}

const worktreeBase = (root) => path.join(root, ".tmp", "commit-check");

function isRegisteredWorktree(root, dir) {
  const list = git(["worktree", "list", "--porcelain"], root).stdout;
  const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  return list
    .split(/\r?\n/)
    .some((l) => l.startsWith("worktree ") && norm(l.slice(9)) === norm(dir));
}

function removeWorktree(root, dir) {
  if (isRegisteredWorktree(root, dir)) git(["worktree", "remove", "--force", dir], root, true);
  git(["worktree", "prune"], root, true);
  return !existsSync(dir);
}

// Remove .tmp/commit-check and .tmp if they are empty; never deletes content.
function pruneEmptyDirs(root) {
  for (const dir of [worktreeBase(root), path.join(root, ".tmp")]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      /* keep */
    }
  }
}

/**
 * Refuse to reuse leftovers of a crashed run. With --clean-stale, only
 * registered worktrees are removed (via git); unknown content is left alone.
 */
function checkStale(root, cleanStale) {
  const base = worktreeBase(root);
  git(["worktree", "prune"], root, true);
  if (!existsSync(base)) return;
  const leftovers = readdirSync(base);
  if (!leftovers.length) return;
  if (!cleanStale) {
    throw new Error(
      `${base} has leftovers from a previous run (${leftovers.join(", ")}); rerun with --clean-stale or inspect them`,
    );
  }
  for (const name of leftovers) {
    const dir = path.join(base, name);
    if (!isRegisteredWorktree(root, dir)) {
      throw new Error(
        `${dir} is not a registered git worktree; refusing to delete it, remove it by hand`,
      );
    }
    if (!removeWorktree(root, dir)) throw new Error(`could not remove stale worktree ${dir}`);
  }
}

function typecheckCommit(root, commit, active, opts) {
  const dir = path.join(worktreeBase(root), commit.short);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  active.add(dir);
  try {
    git(["worktree", "add", "--detach", "--quiet", dir, commit.sha], root);
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) throw new Error(`missing ${tsc}; run npm ci in the main checkout`);
    const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", dir], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    let lint = { skipped: true, reason: "commit predates biome.json" };
    if (opts.lint && existsSync(path.join(dir, "biome.json"))) {
      const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
      const checked = spawnSync(process.execPath, [biome, "lint"], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      lint = {
        pass: checked.status === 0,
        output: `${checked.stdout ?? ""}${checked.stderr ?? ""}`.slice(0, 8000),
      };
    }
    return {
      lint,
      pass: r.status === 0,
      ...summarizeTsc(output),
      raw: r.status === 0 ? "" : output.trim().split(/\r?\n/).slice(0, 5),
    };
  } finally {
    const removed = removeWorktree(root, dir);
    active.delete(dir);
    if (!removed)
      process.stderr.write(`warning: could not remove ${dir}; run with --clean-stale\n`);
  }
}

function format(results) {
  const lines = [];
  for (const r of results) {
    const worst = r.items.some((i) => i.level === "ERROR")
      ? "FAIL"
      : r.items.some((i) => i.level === "WARN")
        ? "WARN"
        : "ok";
    lines.push(`${worst.padEnd(4)} ${r.short} ${r.subject}`);
    for (const i of r.items) lines.push(`     ${i.level.padEnd(5)} [${i.rule}] ${i.message}`);
  }
  const errors = results.reduce((n, r) => n + r.items.filter((i) => i.level === "ERROR").length, 0);
  const warns = results.reduce((n, r) => n + r.items.filter((i) => i.level === "WARN").length, 0);
  lines.push(`\n${results.length} commits, ${errors} errors, ${warns} warnings`);
  return lines.join("\n");
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(
      "usage: node scripts/check-commits.mjs [<base>..<head>] [--typecheck] [--lint] [--json] [--include-merges] [--clean-stale]",
    );
    return 0;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).stdout.trim();
  const range = opts.range ?? defaultRange(root);
  const shas = listCommits(root, range, opts.includeMerges);
  const active = new Set();
  const cleanup = () => {
    for (const d of active) removeWorktree(root, d);
    pruneEmptyDirs(root);
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results = [];
  try {
    if (opts.typecheck || opts.lint) checkStale(root, opts.cleanStale);
    for (const sha of shas) {
      const c = readCommit(root, sha);
      const items = [...lintMessage(c), ...scopeHeuristics(c, { typecheck: opts.typecheck })];
      const result = { sha: c.sha, short: c.short, subject: c.subject, items };
      if (opts.typecheck || opts.lint) {
        if (!opts.json) process.stderr.write(`typecheck ${c.short}…\n`);
        const tc = typecheckCommit(root, c, active, opts);
        result.typecheck = tc;
        if (tc.lint.pass === false) items.push(item("ERROR", "lint", tc.lint.output));
        if (!tc.pass) {
          const detail = tc.first.length ? tc.first : tc.raw;
          items.push(
            item(
              "ERROR",
              "typecheck",
              `tsc --noEmit failed (${tc.count} errors)${detail.length ? ":\n       " + detail.join("\n       ") : ""}`,
            ),
          );
        }
      }
      results.push(result);
    }
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  console.log(opts.json ? JSON.stringify({ range, results }, null, 2) : format(results));
  return results.some((r) => r.items.some((i) => i.level === "ERROR")) ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-commits: ${err.message}`);
      process.exit(2);
    },
  );
}
