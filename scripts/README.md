# Validation and diagnostics

`check-review-ui.mjs` and `check-file-performance.mjs` start an isolated Vite
server and headless browser. Install/provide Playwright and an Edge/Chromium
channel (`PERF_BROWSER`, default `msedge`). `NODE_PATH` can point to a bundled
Playwright installation. Results and screenshots go to `artifacts/performance/`.
The review harness mocks Tauri IPC and file listings; it does not validate a
real remote server. The performance harness measures DOM virtualization and
ordinary-byte ZMODEM input handling, not complete terminal rendering throughput.

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
