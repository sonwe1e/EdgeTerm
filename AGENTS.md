# Repository Guidelines

## Project Structure & Module Organization

EdgeTerm is a React 19/TypeScript terminal client with a Rust/Tauri 2 backend.

- `src/`: frontend logic; `components/` contains UI and `components/panels/` contains Session, Filer, and Sender panels. `workbench/` holds the experiment workbench (project records, editor, diffs, runs, host sampling). `store.ts` manages the terminal Zustand store; `api.ts` wraps IPC; `styles.css` defines styling.
- `src-tauri/src/`: backend commands, session transports in `session/`, and transfer engines in `file_transfer/`. `workspace.rs` persists projects/experiments/runs; `project.rs` runs bounded project inspections and launches. Desktop configuration, permissions, and icons live under `src-tauri/`.
- Tests sit beside frontend modules as `*.test.ts`; Rust tests use module-local tests and `*_tests.rs` fixtures.
- `docs/`: website, screenshots, engineering standards, test plans, and the workbench model/boundaries. `scripts/`: validation, diagnostics, and release utilities.

## Build, Test, and Development Commands

Use Node.js/npm, Rust/Cargo, and the platform's Tauri build prerequisites. Run from the repository root:

On Windows, use the managed npm scripts below, or `./dev.ps1 <task> [args]`
when Node/npm are missing from the current terminal PATH. Start with
`./dev.ps1 doctor`. This selects installed Node plus its npm, resolves Rust
through rustup, and loads MSVC/Windows SDK for native tasks. Do not prepend
agent-bundled runtimes or guess versioned tool directories. See
[build environment](docs/build-environment.zh-CN.md).

The Windows runner uses at most 4 logical CPUs, below-normal priority, and
one independent managed task at a time (including across worktrees). Cargo
jobs and test threads default to 2; Vitest uses at most 2 workers, and browser
files run serially. Run validation commands sequentially. Stop a managed dev
server before starting another managed task. Tauri frontend hooks share the
parent's budget. Use `./dev.ps1 script scripts/<name>.mjs` for diagnostic
scripts; do not bypass the runner with bare npx/cargo for heavy work.

- `npm ci`: install locked frontend dependencies.
- `npm run tauri:dev`: launch the desktop app with Vite.
- `npm run dev`: serve the frontend at port 1420; native IPC requires Tauri.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm test`: run Vitest with jsdom.
- `npm run build`: type-check and build frontend assets.
- `npm run tauri:build`: build desktop bundles.
- `npm run test:rust`: run backend tests with the managed toolchain.
- `npm run cargo -- fmt --manifest-path src-tauri/Cargo.toml -- --check`: check Rust formatting.
- `git diff --check`: detect whitespace errors.

## Coding Style & Naming Conventions

Match existing TypeScript: two-space indentation, double quotes, semicolons, camelCase helpers, and PascalCase components/types. Keep strict TypeScript checks passing. Rust uses four-space indentation, snake_case functions/modules, and rustfmt. Biome runs targeted lint rules with formatting disabled (`npm run lint`). Hook dependencies that intentionally trigger work remain valid; stable event callbacks use `useStableCallback`.

Reuse Codicons through `src/components/icons.tsx`. Put shared preferences in the store; register external panel persistence keys in `src/persistKeys.ts`.

## Testing Guidelines

Follow [engineering standards](docs/engineering-standards.zh-CN.md) and the [test plan](docs/test-plan.zh-CN.md). Workbench behavior and its verified/unverified boundaries are in [docs/workbench.zh-CN.md](docs/workbench.zh-CN.md). Add behavior-focused regressions; demonstrate failure on the old implementation for confirmed defects. Run one frontend file with `npm test -- src/fileSort.test.ts`.

No numerical coverage threshold is configured. Distinguish fixture/jsdom results from real desktop or server validation. Browser harness prerequisites and diagnostic limitations are documented in [scripts/README.md](scripts/README.md).

## Commit & Pull Request Guidelines

Use the history's prefixes: `feat:`, `fix:`, `perf:`, `docs:`, or `chore:`, followed by a concise action (72 chars max) that the commit's own diff proves. Follow R8-R10 in the [engineering standards](docs/engineering-standards.zh-CN.md): one concern per commit, every commit passes typecheck on its own, `perf:` carries `Measured:` or `Unmeasured:`, `fix:` carries `Tests:`, and large commits split or explain `Scope:`. Before a PR, run `npm run check:commits -- <base>..HEAD --typecheck` (temporary worktrees go under the ignored `.tmp/`; never link `node_modules` into a worktree). Keep PRs focused and disclose stacked dependencies. Describe the problem, final behavior, related issues/review items, validation commands/results, and untested environments. Include screenshots or recordings for UI changes and comparable measurements for performance claims.

## Published History, Upstream, and Distribution

- This distribution is `sonwe1e/EdgeTerm`; `miskin-lee/EdgeTerm` is upstream. Preserve original attribution and license notices, but route this fork's downloads, support, and update entry points to this repository. Shared frontend URLs live in `src/distribution.ts`.
- Read [release history](docs/releases.zh-CN.md), [upstream ports](docs/upstream-ports.zh-CN.md), and [branch history](docs/history-and-branches.zh-CN.md) before release or history maintenance. Keep these records current when their facts change; distinguish dated observations from current state.
- Never rewrite published `main` history, move published tags, or replace published binaries to tidy history. Correct mistakes with new commits/notes and a new release version. Reorder/squash only unpublished, unshared work. Do not recreate the old re-split/merge cycle.
- This fork currently ships manual Windows x64 downloads. The app must not check the upstream updater feed, claim it verified the latest fork version, or install an upstream package. The inherited signed-release workflow is explicitly disabled; enabling automatic updates requires this fork's own signing identity/feed, matching client/configuration, and real update acceptance. Do not promise macOS/Linux packages without actually publishing and validating them.
- Use an independent version series: patch for compatible fixes, minor for compatible features; explain migrations for breaking changes. Use `version:set` only when preparing a release; identify development artifacts by base version plus Git SHA. Record the exact release commit, platform, checksum and verification boundaries. Missing historical release numbers stay missing.
- For upstream synchronization, record every source commit's disposition (direct port, adaptation, existing capability, or not adopted) and local commit/test evidence in the port index. Use `cherry-pick -x` for direct ports and `Upstream: <URL / full SHA>` for adaptations. Never copy upstream version bumps, signing keys, update URLs or feature removals without evaluating their fit for this distribution.
- Check ancestry, unique patches and worktree occupancy before cleaning branches. Keep unpublished historical tips under dated `archive/` refs; do not develop on or merge those refs wholesale. Recheck remote state and active use before remote cleanup. Local archival is not a remote backup; preserve experiment branches separately from the release line.
