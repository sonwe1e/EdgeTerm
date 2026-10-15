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
