# Validation and diagnostics

`check-review-ui.mjs` and `check-file-performance.mjs` start an isolated Vite
server and headless browser. Playwright is a devDependency, so the scripts
resolve it from `node_modules` (no `NODE_PATH` needed). They drive an
Edge/Chromium channel (`PERF_BROWSER`, default `msedge`); on a clean machine
install it once with `npx playwright install msedge`, or install Microsoft
Edge. Results and screenshots go to `artifacts/performance/`.
The review harness mocks Tauri IPC and file listings; it does not validate a
real remote server. The performance harness measures DOM virtualization and
ordinary-byte ZMODEM input handling, not complete terminal rendering throughput.

`npm run test:browser` runs the `src/**/*.browser.test.ts` contracts in a
headless browser through the same provider; `npm test` stays the fast jsdom
unit project and skips those files. The browser project does not load
`src/test/setup.ts` — those are jsdom stubs, and stubbing canvas or layout
there would defeat the point of the browser run. By default it uses
Playwright's own Chromium (`npx playwright install chromium` on a clean
machine); setting `PERF_BROWSER` drives a system channel instead, e.g.
`PERF_BROWSER=msedge` for the installed Microsoft Edge.

`check-file-performance.mjs` additionally gates two timings, each the median of
5 samples, and exits 1 when one is breached (it prints
`FAIL <name>: <measured> ms (gate <limit> ms)` and writes every sample, median
and limit to `artifacts/performance/results.json`):

- first paint of a 10,000-row listing: the root is unmounted, then one
  `FileBrowser` with 10,000 synthetic entries is mounted inside `flushSync` and
  the script waits two animation frames. It covers React commit, the row window
  calculation, layout and paint of the mounted list.
- tab switch between two mounted 10,000-row listings: both panes stay mounted
  and visibility moves between them through the app's own `.pane-slot` /
  `.is-hidden` classes and percentage geometry. It covers React reconciliation
  plus layout/paint of showing the other pane.

Thresholds chosen from measured headroom on one developer machine (Edge
155.0.4283.45 headless, 10,000 synthetic rows, 1100x720 viewport): first paint
median 27.0 ms, samples 25.8-27.1 ms, gate 200 ms; tab switch median 13.0 ms,
samples 7.3-13.3 ms, gate 100 ms. Re-record the raw numbers whenever a
threshold or the workload changes, and treat them as this machine's numbers
only.

The tab-switch gate does not cover terminal tabs: a real tab switch needs a PTY
session and xterm, so the harness switches two file listings instead. TabStrip
rendering, terminal fit and repaint, and the store's `activeId` churn are not
measured by it.

Boundary for everything above (R1): headless Edge, synthetic listings and
component props in place of IPC prove this harness's DOM and component
behaviour only. They do not prove WebView2 frame times, GPU cost, or anything
about a real server; those need the disposable CDP app instance described
below.

`check-hidden-render.mjs` mounts a real xterm and the real `styles.css` in
headless Edge, keeps writing one line per frame, and counts the frames it
renders while its `.pane-slot` is hidden. It exits 1 if the hidden slot still
renders (the old `visibility: hidden` rendered 120 of 120 frames; `display:
none` renders 0). It proves the renderer pauses in Chromium only; it says
nothing about WebView2, WebKitGTK or old GPUs.

`check-gutter-alignment.mjs` and `check-app-font-chain.mjs` build the real
production bundle (the repo's `vite.config.ts`, platform defines included)
and drive it headless. The gutter gate runs the real SessionPane through the
component hide → resize → show chain and a hidden store font change, and
measures the line-number gutter against the real xterm row rectangles; the
dev-mode Vitest contracts do not reproduce the production build's timing
there. The font gate drives the real App over the real store chain (no
terminal session is involved — that is the gutter gate's path) and asserts
the audited 12/18px literals (App variable, inner row height, date-column
font, consecutive-row pitch) at 1100px and 760px with 10,000 windowed
entries.

Run them with a unique results name (earlier results are never overwritten)
and pick the engine with the environment knobs:

- `node scripts/check-gutter-alignment.mjs gutter-check-chromium`
  — Playwright Chromium.
- `PERF_ENGINE=webkit node scripts/check-gutter-alignment.mjs gutter-check-webkit`
  — Playwright WebKit (not WKWebView or WebKitGTK).
- `PERF_BROWSER=msedge node scripts/check-app-font-chain.mjs app-font-msedge-<date>`
  — the installed Microsoft Edge; without `PERF_BROWSER` the app gate uses
  Playwright Chromium.

`EDGE_GUTTER_ROOT` (gutter gate) and `EDGE_APP_FONT_ROOT` (font gate) point
the build at a disposable registered worktree under `.tmp/mutate`, so mutant
sources run through the same gate. Both scripts record unexpected IPC
commands and page/console/resource errors and exit non-zero on any of them;
result JSON and screenshots go under `.tmp/records/implementation-03/` named
after the results argument. The recorded fields, not the file-name label,
carry the engine evidence (`browser` is the full browser version, `channel`
the requested channel). Boundaries: synthetic entries and stubbed IPC prove
the front-end measurement and chain behaviour in a real browser engine; they
say nothing about PTY round-trips, WebView2 packaging or real servers.

The older `cdp-*.cjs` and Win32 `.ps1` files are exploratory diagnostics. Use a
disposable app instance with synthetic local sessions. They can change window
geometry, renderer settings, instrumentation and CPU throttling; synthetic DOM
pointer events are not equivalent to an OS pointer gesture. The new isolated
review harness uses Playwright pointer input instead.

CDP scripts require `EDGETERM_CDP_TARGET_ID` from the dedicated app's
`http://127.0.0.1:9222/json/list`; the helper refuses arbitrary first-page
fallbacks. The flood script additionally requires zero existing sessions and
only writes its workload to its one newly opened local session. Close the
disposable app after diagnostics, including after errors, to clear temporary
instrumentation. A script completing without reproduction does not prove that
a reported freeze was fixed. `cdp-measure-loop.cjs` is observation only, not a
pass/fail regression gate.

The Win32 scripts have machine-specific process/window assumptions. Pass `-Exe`
explicitly when using them on another checkout. They were not run against the
user's desktop during the 2026-10-14 audit.

`check-native-terminal-tabs.mjs <new-output-dir>` drives a disposable Windows
portable release through WebView2 CDP. Set `EDGETERM_CDP_URL` (default
`http://127.0.0.1:9241`) and explicitly select its page with
`EDGETERM_CDP_TARGET_ID` from that endpoint's `/json/list`. The instance must
have no saved profiles or open sessions and must use the default GPU option.
It opens eight local ConPTY sessions, writes three bursts of 20,000 synthetic
lines into the first, checks search/input and cycles all eight tabs three
times. JSON samples include shortcut dispatch and two animation frames; they
are not a pure key-to-pixel latency measurement. The behavior gate checks that
evicted hidden DOM fallbacks do not paint rows, rather than imposing an
arbitrary timing threshold. A CPU profile and screenshot are saved alongside
the results. The script closes its test sessions; close the disposable app
afterward, including on failure. Do not run builds or other tests during the
timed portion. This proves the recorded WebView2/ConPTY workload only.

`check-native-profile-recovery.mjs <seed|blocked|restored> <data-dir>
<new-output-dir>` uses the same explicit CDP target selection and requires a
portable instance whose data directory is under the repository's `.tmp/`.
Run each mode in a separate process launch: `seed` saves an original synthetic
profile; with the app closed, retain a good copy of `sessions.json` and inject
truncated JSON into this test directory; `blocked` checks the startup error,
refused save and byte-for-byte preservation; close the app, restore the good
copy, and use `restored` to verify that the original remains and a new save
works. It never edits the configuration itself. The screenshots and JSON
demonstrate actual native IPC/startup behavior, not disk-full or crash-safe
transactional writes, OS vault persistence, or another platform's behavior.

### Static checks

`npm run lint` runs Biome 2.5.15 without formatting. Unused variables/imports and
missing React dependencies are errors; explicit `any` is a warning. Extra effect
dependencies are allowed because retry/revision/layout tokens intentionally trigger
work. `useStableCallback` is registered as returning a stable event callback;
subscription lifetimes still use explicit dependencies. `check:commits -- <range>
--typecheck --lint` checks each revision in an isolated worktree; revisions before
biome.json are reported as skipped for lint, rather than using a future config.
