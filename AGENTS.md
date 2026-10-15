# Repository Guidelines

## Project Structure & Module Organization

EdgeTerm is a React 19/TypeScript terminal client with a Rust/Tauri 2 backend.

- `src/`: frontend logic; `components/` contains UI and `components/panels/` contains Session, Filer, and Sender panels. `store.ts` manages Zustand state; `api.ts` wraps IPC; `styles.css` defines styling.
- `src-tauri/src/`: backend commands, session transports in `session/`, and transfer engines in `file_transfer/`. Desktop configuration, permissions, and icons live under `src-tauri/`.
- Tests sit beside frontend modules as `*.test.ts`; Rust tests use module-local tests and `*_tests.rs` fixtures.
- `docs/`: website, screenshots, engineering standards, and test plans. `scripts/`: validation, diagnostics, and release utilities.

## Build, Test, and Development Commands

Use Node.js/npm, Rust/Cargo, and the platform's Tauri build prerequisites. Run from the repository root:

- `npm ci`: install locked frontend dependencies.
- `npm run tauri:dev`: launch the desktop app with Vite.
- `npm run dev`: serve the frontend at port 1420; native IPC requires Tauri.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm test`: run Vitest with jsdom.
- `npm run build`: type-check and build frontend assets.
- `npm run tauri:build`: build desktop bundles.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: run backend tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: check Rust formatting.
- `git diff --check`: detect whitespace errors.

## Coding Style & Naming Conventions

Match existing TypeScript: two-space indentation, double quotes, semicolons, camelCase helpers, and PascalCase components/types. Keep strict TypeScript checks passing. Rust uses four-space indentation, snake_case functions/modules, and rustfmt. Biome runs targeted lint rules with formatting disabled (`npm run lint`). Hook dependencies that intentionally trigger work remain valid; stable event callbacks use `useStableCallback`.

Reuse Codicons through `src/components/icons.tsx`. Put shared preferences in the store; register external panel persistence keys in `src/persistKeys.ts`.

## Testing Guidelines

Follow [engineering standards](docs/engineering-standards.zh-CN.md) and the [test plan](docs/test-plan.zh-CN.md). Add behavior-focused regressions; demonstrate failure on the old implementation for confirmed defects. Run one frontend file with `npm test -- src/fileSort.test.ts`.

No numerical coverage threshold is configured. Distinguish fixture/jsdom results from real desktop or server validation. Browser harness prerequisites and diagnostic limitations are documented in [scripts/README.md](scripts/README.md).

## Commit & Pull Request Guidelines

Use the history's prefixes: `feat:`, `fix:`, `perf:`, `docs:`, or `chore:`, followed by a concise action (72 chars max) that the commit's own diff proves. Follow R8-R10 in the [engineering standards](docs/engineering-standards.zh-CN.md): one concern per commit, every commit passes typecheck on its own, `perf:` carries `Measured:` or `Unmeasured:`, `fix:` carries `Tests:`, and large commits split or explain `Scope:`. Before a PR, run `npm run check:commits -- <base>..HEAD --typecheck` (temporary worktrees go under the ignored `.tmp/`; never link `node_modules` into a worktree). Keep PRs focused and disclose stacked dependencies. Describe the problem, final behavior, related issues/review items, validation commands/results, and untested environments. Include screenshots or recordings for UI changes and comparable measurements for performance claims.
