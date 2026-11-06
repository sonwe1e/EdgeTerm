# Validation and diagnostics

`./dev.ps1 script scripts/check-native-codex-selection.mjs <new-dir-under-.tmp>`
uses the installed Codex executable named by `EDGETERM_CODEX_EXE` in the same
disposable CDP setup. It creates a separate `CODEX_HOME` and a loopback Responses
fixture that returns text only, then tests actual Codex ordinary/Shift selection,
highlight persistence, quote undo/redo and New command. It does not use account
credentials or existing conversations. The current coordinate fixture targets
Codex 0.166.0 with the default Chinese EdgeTerm UI; screenshots and assertions
make layout/version mismatches visible. Never point it at a user's active app.

`./dev.ps1 script scripts/check-native-agent-selection.mjs <new-dir-under-.tmp>`
checks selected-text quoting in a disposable packaged Windows WebView2 app,
using real ConPTY output and Playwright drag/click input. Set
`EDGETERM_CDP_URL` and `EDGETERM_CDP_TARGET_ID` to that instance explicitly.
The gate requires empty profiles/sessions, creates its own text-only terminal
fixture, checks inline and dialog quoting, fullscreen Shift selection, Chinese
multiline indentation and absence of unintended PTY input, and closes its own
session. Screenshots and `result.json` stay in the new output directory. It
does not access actual agent conversations or call a model. When the normal
app is already running, build the disposable copy with a distinct Tauri
identifier; a second copy with the same identifier only activates the first.

Use the managed task entry for builds/tests and diagnostics. On Windows,
`./dev.ps1 doctor` reports the selected Node/npm, Rust, MSVC, Windows SDK and
resource budget even when the current shell has an incomplete PATH. Existing
`npm run` commands use the same entry. For standalone harnesses below, use
`./dev.ps1 script scripts/check-review-ui.mjs` (or another script path).
Run independent tasks sequentially; Windows rejects a second managed task
while a build/test/dev server is active. Tauri's nested frontend hooks remain
allowed. See [build environment and limits](../docs/build-environment.zh-CN.md).

`check-review-ui.mjs` and `check-file-performance.mjs` start an isolated Vite
server and headless browser. Playwright is a devDependency, so the scripts
resolve it from `node_modules` (no `NODE_PATH` needed). They drive an
Edge/Chromium channel (`PERF_BROWSER`, default `msedge`); on a clean machine
install it once with `npx playwright install msedge`, or install Microsoft
Edge. Results and screenshots go to `artifacts/performance/`.
The isolated Vite gates exclude `.tmp/` from file watching: historical builds
and disposable worktrees are not fixture inputs, and watching those trees can
delay Playwright initialization or reload a running gate when worktrees change.
The review harness mocks Tauri IPC and file listings; it does not validate a
real remote server. The performance harness measures DOM virtualization and
ordinary-byte ZMODEM input handling, not complete terminal rendering throughput.

`./dev.ps1 script scripts/check-refinement-shots.mjs <results-name>` builds
the real app and captures representative screens with synthetic state and a
permissive IPC stub. Results and layout findings are written under
`.tmp/records/refinement-shots/`. For a same-fixture tab comparison, set
`REFINEMENT_TAB_BASELINE_DIR` to a directory containing earlier copies named
`TabStrip.tsx` and `tabs.styles.css`; only those two sources are substituted
and the manifest records the choice. These images do not validate native
WebView2 interaction or real sessions.

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

`./dev.ps1 script scripts/check-multiterminal-output.mjs <new-results-name>`
drives four real terminal controllers in headless Edge (one visible, three
hidden) with synthetic byte streams. It records scrolling output, continuous
alternate-screen redraws, and alternate-screen redraws separated by quiet
periods after 8,000 lines of normal history. Its behavior gate requires a
hidden scrolling terminal to skip viewport coloring and the covered normal
history to skip backlog coloring while the alternate screen is active. Raw
samples, browser version and instrumentation timings go to a new directory
under `.tmp/records/multiterminal-output/`; existing results are not replaced.
Timing values are diagnostic, not thresholds. On this Windows machine with
Edge 156.0.4314.50, three samples of the scrolling fixture went from 234 hidden
viewport passes each to zero; the quiet alternate-screen fixture went from
15–16 backlog slices (98.6–117.5 ms total) to zero. These synthetic browser
results do not measure a native WebView2/ConPTY session or OpenCode itself.

`check-gutter-alignment.mjs` and `check-app-font-chain.mjs` build the real
production bundle (the repo's `vite.config.ts`, platform defines included)
and drive it headless. The gutter gate runs the real SessionPane through the
component hide → resize → show chain and a hidden store font change, and
measures the line-number gutter against the real xterm row rectangles; the
dev-mode Vitest contracts do not reproduce the production build's timing
there. The font gate drives the real App over the real store chain (no
terminal session is involved — that is the gutter gate's path) and asserts
the audited 12/18px literals (App variable, inner row height, date-column
font, consecutive-row pitch) at 1100px and the minimum desktop size read from
`tauri.conf.json` (currently 900×560), with 10,000 windowed entries. At supported
sizes it also requires the fixture names to fit initially and each rendered
date to fit its cell and the list viewport after revealing the counted columns.
When the panel is too narrow to show both, it scrolls horizontally and provides
a visible control to reveal the other columns. The older 760px browser probe
remains: font, pitch and virtualization still gate the run; needing horizontal
scrolling below the desktop minimum is recorded in `boundaryFindings`.
Screenshots at every width with the 18px panel font preserve that evidence.
The IPC whitelist includes recoverable-transfer listing and the close-to-tray
preference; any other unexpected command still fails the gate.

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

`diagnose-hang.ps1` is the read-only, external Windows 11 hang collector.
Run it on the affected machine while the app is still stuck, or double-click
the adjacent `diagnose-hang.cmd`. It accepts a unique `edgeterm.exe`, otherwise
requires `-ProcessId <PID>`. JSON goes to Desktop/EdgeTerm-diagnostics (override
with `-OutputDirectory`). It records app SHA/version, OS/GPU/runtime versions,
window DPI/regions, one bounded native-message probe, and two process samples.
It does not restart or kill processes, take screenshots, read terminal text,
export full command lines, or upload anything. A successful probe does not
prove JavaScript responsiveness; a timeout does not prove deadlock. See the
[hang guide](../docs/sidebar-freeze-diagnostics.zh-CN.md). The Windows-only
`diagnose-hang.test.mjs` uses a hidden native window and synthetic inventory,
never the user's running EdgeTerm, to test both response and timeout paths.

The other older `cdp-*.cjs` and Win32 `.ps1` files are exploratory diagnostics. Use a
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
It opens eight local ConPTY sessions, first writes 1,500 synthetic lines into
each of three background sessions concurrently and searches for their final
lines, then writes three bursts of 20,000 lines into the first. It checks
search/input and cycles all eight tabs three times. JSON samples include
shortcut dispatch and two animation frames; they
are not a pure key-to-pixel latency measurement. The behavior gate observes
hidden DOM fallbacks after settling; rows previously painted while visible may
remain, but the hidden DOM must not keep changing. It does not impose an
arbitrary timing threshold. A CPU profile and screenshot are saved alongside
the results. The script closes its test sessions; close the disposable app
afterward, including on failure. Do not run builds or other tests during the
timed portion. This proves the recorded WebView2/ConPTY workload only.

`check-native-terminal-input.mjs <new-output-dir-under-.tmp>` uses an explicitly
selected disposable portable WebView2 target (`EDGETERM_CDP_URL` and
`EDGETERM_CDP_TARGET_ID`). Set `EDGETERM_PI_ROOT` to an installed
`@earendil-works/pi-coding-agent` package. It launches the entry declared by
that package's `bin.pi`, creates a separate Pi agent configuration and 160
generated messages, resumes them offline without model requests, then checks
transcript wheel scrolling in both directions, Alt+Delete word deletion without
opening the menu, and Ctrl+Tab / Ctrl+Shift+Tab navigation between two local
sessions. It records the command entry, emitted mouse reports, screenshots,
Pi version and browser environment. Its DOM renderer setting applies only to
the disposable app profile. Close that app afterward. When another EdgeTerm is
running, build the test copy with a separate Tauri `identifier` and give it its
own `WEBVIEW2_USER_DATA_FOLDER` to keep the single-instance guard and browser
profile isolated. These checks cover the recorded Windows/Pi version only.
The script records whether the actual bundled command has the local
startup-order repair described below; it never patches Pi itself.

After the input checks, the script exits Pi normally and requires a shell
completion marker, released mouse reporting, no generated history markers
after leaving the alternate screen, a resume hint, and all 160 saved messages
unchanged. It captures both the TUI write log and the PTY output: Pi prints
the resume hint directly to stdout, outside its TUI log. Optional arguments
are `[resume-hint|default|transcript] [ctrl-d|ctrl-c|quit]`. The defaults are
`resume-hint ctrl-d`; select `quit` or `ctrl-c` to check the other normal exit
paths. `default` leaves the exit preference unset in the isolated profile;
Pi 1.4.0 then reprints the transcript and the gate intentionally fails.
This fixture setting never changes the user's Pi configuration. For the
user-level repair, set `fullscreenExitOutput` to `resume-hint` in the Pi agent
directory's `settings.json` and run `/reload` in an already running Pi.

`./dev.ps1 script scripts/patch-pi-windows-mouse.mjs` repairs native Windows
Pi 1.4.0's fullscreen startup order in the installation explicitly selected by
`EDGETERM_PI_ROOT`. It reissues mouse modes after Windows VT input is enabled
in both the SDK's TUI module and the bundled TUI actually loaded by the npm
`pi` command. It checks versions, command entry, import and source shapes for
both targets before writing, and saves originals beside each target with the
suffix `.edgeterm-windows-mouse.bak`. It can complete the earlier SDK-only
repair without replacing its backup. Repeating the command is idempotent;
`--restore` checks both files and restores their backups. Restart Pi after
applying it. Reinstalling/upgrading Pi may replace the patched package; another
version needs its own review. This is an optional local Pi repair, not a patch
to the PTY backend or a dependency shipped with EdgeTerm. Its fixture tests are
in `patch-pi-windows-mouse.test.mjs`; the real command's before/after results
are in [terminal input findings](../docs/terminal-input-fixes.zh-CN.md).

`check-native-sidebar-drag.mjs <new-output-dir>` uses the same explicit CDP
target and portable-instance guards, with no saved profiles or sessions. It
opens the Filer and three local shells, writes 3,000 synthetic lines to the
first, and performs six slow alternating sidebar drags with Playwright mouse
input. The fixture folder and screenshot use the new output directory. The
gate observes the terminal container and xterm screen widths while held and
after release; it does not inspect IPC or measure the likelihood of a freeze.
The script closes its test sessions; close the disposable app afterwards.
CDP mouse input is not an OS pointer gesture, and this workload is not the
user's OpenCode session.

`seed-native-opencode-perf.mjs <new-fixture-file>` and
`check-native-opencode-perf.mjs <new-output-dir>` exercise the real OpenCode 2.x
TUI with generated conversations. Use an isolated OpenCode server on loopback
with empty XDG data/config/cache/state and TEMP/TMP directories, an empty test
project under `.tmp/`, and a private `OPENCODE_PASSWORD`; never point the seed
script at a server containing personal sessions. Set `EDGETERM_OPENCODE_SERVER`
to that server, `EDGETERM_OPENCODE_PROJECT` to the test project, and run the
seed script through `./dev.ps1 script`. It refuses a nonempty session listing and
imports 16- and 480-message fixtures without invoking a model. Set
`EDGETERM_OPENCODE_FIXTURES` to its output and `EDGETERM_OPENCODE_EXE` to the
OpenCode executable. Launch a separate portable EdgeTerm process with the same
isolated environment and password, enable WebView2 CDP, and set
`EDGETERM_CDP_TARGET_ID` to its explicit page ID. The second script refuses
saved profiles or existing terminal sessions, opens test shells, scrolls the
short and long conversations, and switches eight tabs. Close the disposable
app and server after the run. Its screenshots contain generated text; CPU
profiles, frame intervals and shortcut-plus-two-frame samples are diagnostic
observations, not input-to-pixel latency or proof about a user's own workload.

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

`check-native-file-io.mjs <new-output-dir>` drives a disposable Windows portable
release with the current raw-byte file IPC commands. Set `EDGETERM_CDP_URL`
and explicitly select its page using `EDGETERM_CDP_TARGET_ID`; use a fresh output
directory under the repository's `.tmp/`. It checks eight concurrent 1 MiB writes
followed by immediate byte-for-byte reads, a Unicode path, a nonzero typed-array
offset, and file-read offsets. This exercises real WebView2 IPC and local disk;
it does not validate remote transfer engines or other desktop platforms.

### Terminal wrap responsiveness

`./dev.ps1 script scripts/check-terminal-wrap-responsiveness.mjs <output.json>`
uses an isolated Vite/Edge page and the real terminal controller's byte-write
hooks. It fills a normal buffer (with and without scrollback) and an alternate
screen with soft wraps until the original first row is trimmed, then checks
continued output and event-loop progress. Its external three-second watchdog
can fail and close a renderer trapped in a synchronous loop. `EDGETERM_WRAP_ROOT`
selects a disposable worktree for the same baseline check; no dependency links
are needed. The report records the semantic renderer's source hash and browser
version. There is no attached canvas/DOM terminal renderer, native IPC or server
in this fixture. `terminalSemanticRenderer.test.ts` additionally checks viewport
and deferred history walks using real xterm buffers, with an out-of-range read
trap so the old implementation fails without hanging Vitest. The actual Windows
incident and separate WebView2 validation are recorded in the
[hang guide](../docs/sidebar-freeze-diagnostics.zh-CN.md#11-2026-11-01备用屏幕折行导致语义着色死循环).

### Terminal search responsiveness

`./dev.ps1 script scripts/check-search-responsiveness.mjs <output.json>` starts
an isolated Vite/Edge instance with one real xterm and synthetic text. It runs
`^(a+)+$` against 32 `a` characters followed by `!`, probes renderer liveness
from outside the page, checks the explicit timeout, then searches again.
Failure exits nonzero and the browser/server are closed even when the renderer
stalls. Reports include source hash, browser, OS and workload. This is a
front-end liveness regression, not a native WebView2 or server benchmark.
`src/test/terminalRegex.browser.test.ts` covers cancellation, search-box recovery,
selection, wrapping, navigation past the highlight limit and bounded painting;
`src/workbench/searchInteraction.browser.test.ts` covers StrictMode request
completion and quick-open keyboard navigation with fixture IPC responses.

### Terminal file-link detection baseline

`./dev.ps1 script scripts/measure-file-links.mjs` records the first
performance baseline for the file-link provider (`src/terminalFileLinks.ts`)
under high output — the docs/team/STATE.md item that had never been measured.
It reuses the measure-agent-scroll harness shape — an isolated headless-Edge
page (same `PERF_BROWSER` knob, default `msedge`), a real xterm with no
attached renderer, no mouse pipeline and no IPC — but serves the page itself
through a minimal in-process HTTP server: the page, the xterm bundle, and the
provider transpiled in-process with the repo's TypeScript. A confined sandbox
forbids the esbuild service pipes (piped stdio) that a Vite dev server and
Playwright's default browser transport need; when Playwright's direct launch
fails, the script automatically spawns the browser on a loopback debug port
and connects over a WebSocket instead. No build tooling or browser helper
spawns with pipes at measure time. Where even spawning the browser is
forbidden, set `EDGETERM_FILE_LINKS_CDP=http://127.0.0.1:<port>` to measure
against an already-running debug browser; the script leaves that browser
running for its owner to close. The script writes about
800,000 characters of mixed output into two terminals (80x24 and 200x24,
scrollback 10000): plain log lines, Python traceback rows, `path:line`
references, quoted paths, tokens at and just over the 1024-char path limit
(which wrap across rows), and URL prose. `--chars=N` changes the byte budget
and `--rows=N` switches to an N-line workload (e.g. 100000) that keeps the
buffer trimming while it is written.

The provider is registered through the same `term.registerLinkProvider`
path as `src/terminal.ts`, wrapped to time every `provideLinks` call. A
pointer sweep is emulated by evaluating the viewport's 24 rows per sweep
(12 sweeps = 288 calls, 2 warm-up sweeps discarded): the linkifier pays one
full-row evaluation each time a moving pointer crosses into a new row, while
high output with a still pointer performs zero evaluations. The report has
per-call p50/p95/p99, per-sweep totals, and a diagnostic whole-buffer
per-row pass. On a non-isolated page `performance.now()` is quantized to
~0.1 ms, so sweep totals and whole-buffer means are the accurate
cross-check for the coarse per-call percentiles. A fixed validation block
asserts that traceback and `path:line` rows produce their expected links and
a plain row produces none, so a fixture regression cannot measure nothing.

JSON lands in `artifacts/performance/file-links/measure-<timestamp>.json`
(`--out=<path>` overrides; a path outside ignored directories works where a
sandbox denies writes to `artifacts/`) with the browser, OS, xterm version
and the provider source hash. There are deliberately no performance gates yet:
first-round numbers are recorded for later threshold decisions, and only an
error, a fixture self-check failure, or a per-call p95 sanity tripwire above
50 ms exits nonzero. Boundary: provider evaluation cost only — xterm's own
linkifier row caching/dispose, renderer hit-testing, hover underlining,
click/open IO and native WebView2 are not covered, and values are
machine-specific. Dated observation (2026-11-07, this Windows machine,
headless Edge 157.0.4341.42 through `EDGETERM_FILE_LINKS_CDP`): 80x24 —
800,994-char mixed stream, 10,024 buffer rows, whole-buffer pass 19.0-19.6 ms
(~0.002 ms/row); 200x24 — 801,612 chars, 5,242 rows, 17.1-17.8 ms
(~0.0034 ms/row); sweep per-call samples quantized to 0-0.1 ms at the page
clock's resolution, orders of magnitude under the tripwire; two consecutive
runs agreed within ~0.7 ms on the whole-buffer totals.

### Terminal memory and throughput baseline (A1-lite)

`./dev.ps1 script scripts/measure-terminal-memory.mjs` records the first
measured memory, throughput and scroll numbers for xterm buffers
(docs/team/STATE.md roadmap A1, lite matrix), reusing the file-link baseline's
harness: an in-process HTTP page with a real renderer-less xterm, the same
browser launch adaptivity, and `--out=<path>` for sandboxes that cannot write
`artifacts/`. The matrix is W1 (plain seq-style lines) and W3 (agent-style
short lines with frequent SGR color switches, one `\r` spinner line of 20
same-position redraws every 10 lines, and occasional `\x1b[K`) across rows
{10000, 100000} and cols {80, 200}, with scrollback set to the row count.
W2-style colored listings and the 1M-row point are deferred.

Per variant the report records: the JS heap delta measured through a CDP
session (`HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`, before
Terminal creation vs after the write plus GC); write throughput in 64 KiB
chunks timed by the `term.write` callbacks (MB = 1e6 UTF-16 code units,
escapes included); a scroll p95 from 64 `requestAnimationFrame` interval
samples while alternating `scrollLines(-400)` and `scrollToTop`; and the
ratio of the measured heap delta to the A0 formula lower bound
(rows x cols x 12 / 1e6 MB), reported as a cross-check only. Validation
asserts `buffer.length === rows + 1` and the first/last row text, so a
workload or wrap regression cannot measure the wrong shape.

Set `EDGETERM_MEASURE_CDP` (or the script-specific
`EDGETERM_TERMINAL_MEMORY_CDP`) to an already-running debug browser where
spawning one is forbidden; the script disconnects without closing it.
Non-gating: only errors and fixture self-check failures exit nonzero, and
numbers wait for A1 threshold decisions. Boundary: heap figures are the
page's V8 JS heap, not the WebView2/browser process working set; throughput
covers the xterm parser and buffer, not PTY or network; scroll intervals are
rAF cadence without a renderer — a JS-side upper bound, not frame time.
Dated observation (2026-11-07, this Windows machine, headless Edge
157.0.4341.42 through `EDGETERM_MEASURE_CDP`, two consecutive runs): heap
delta scaled with rows and was independent of cols — ~2.2-2.4 MB at 10k rows
and ~20.55-20.60 MB at 100k rows for both W1 and W3 (~205-240 bytes per
short row), so xterm 6.0 stores lines by content, not by terminal width,
and the A0 rows*cols*12 formula overestimates short-line buffers by up to
~11x (ratio 0.086 at 100k x 200). Write throughput ran 6.6-15.7 MB/s (W1
faster than W3; 80 cols faster than 200; larger buffers slower per char);
scroll p50/p95 stayed at ~7/8 ms across all variants. Heap deltas agreed
between the two runs within 0.2%.

### Native SSH program checks

`scripts/check-native-opencode-ssh.mjs` checks OpenCode 2.2.5 idle activity in an
explicitly selected disposable WebView2 instance (`EDGETERM_CDP_URL` and
`EDGETERM_CDP_TARGET_ID`). Run it with `./dev.ps1 script` and a fresh output path
under `.tmp`. It requires a dedicated local OpenSSH account `edgeterm`, its test
key at `.tmp/ssh/id_ed25519`, and a remote setup script passed as
`EDGETERM_OPENCODE_ENV`. The setup must put OpenCode on PATH, disable providers,
create a separate Linux home named `/tmp/edgeterm-opencode-225.*`, print
`FIXTURE_READY` and `FIXTURE_HOME:<path>`, and set the prompt to
`edgeterm@fixture:~/project$ `. It uses a loopback proxy on port 22625 to add
200 ms downstream latency. The test instance must have no profiles or sessions;
its SSH connection uses the application's normal known-host verification.
Set `EDGETERM_OPENCODE_EXPECT_BUG=1` only when checking the old implementation.
Evidence includes screenshots, raw output from this test session and JSON state
checks. It submits no model prompt. The launching wrapper must stop the isolated
OpenCode background server after the test and close only its own app instance.

`check-native-pi-ssh.mjs <new-output-dir>` uses the same explicit disposable
WebView2 target, empty profiles/sessions, local SSH account/key, port 22625 proxy
and 200 ms downstream latency. Set `EDGETERM_PI_SSH_ENV` to an isolated Linux
setup script, and `EDGETERM_PI_SSH_CONTROL` to a helper that accepts the fixture
home and `disable`/`enable` and writes mouse-mode escapes only to that fixture's
owned PTY. The setup prints `FIXTURE_READY` and `FIXTURE_HOME:<path>` using a
fresh `/tmp/edgeterm-pi-ssh.*` home, sets `edgeterm@fixture:~/pi-project$ ` as its
prompt, and makes `pi` launch official Pi 1.5.0 offline/fullscreen with 80
generated question/answer pairs. Each answer has eight lines containing
`PI-HISTORY-NNN`. Disable extensions, MCP, tools and provider credentials; use
`fullscreenExitOutput: "resume-hint"`. The helper must validate the fixture path,
owner and `/dev/pts/` device before touching it. The script invokes this helper
through WSL `Ubuntu-26.04` as the dedicated `edgeterm` account.

The test checks normal SGR scrolling, deliberate mouse-mode loss, up/down
transcript paging with a preserved draft, restored mouse reporting and normal
Pi exit. Set `EDGETERM_PI_EXPECT_BUG=1` for the old implementation: it must send
arrow keys, replace the draft and leave the transcript at the latest message.
The launching wrapper closes only its own app. JSON and screenshots are real
Windows release/WebView2, SSH and Pi evidence with generated history and CDP
input; they do not prove why mouse mode was lost on a user's remote server.

### Static checks

`npm run format` applies Biome 2.5.15 formatting; `npm run format:check` checks
without writing. Both use the managed task runner, accept optional file paths,
and skip generated `src/bindings.ts`. See [code style and debugging](../docs/code-style.zh-CN.md)
for scope, editor settings, and the separate rustfmt command.

`npm run lint` runs Biome's lint rules independently of formatting. Unused variables/imports and
missing React dependencies are errors; explicit `any` is a warning. Extra effect
dependencies are allowed because retry/revision/layout tokens intentionally trigger
work. `useStableCallback` is registered as returning a stable event callback;
subscription lifetimes still use explicit dependencies. `check:commits -- <range>
--typecheck --lint` checks each revision in an isolated worktree; revisions before
biome.json are reported as skipped for lint, rather than using a future config.
