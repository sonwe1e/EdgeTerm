// Visual evidence for the UI refinement: the surfaces the font-chain gate
// does not reach. Real App, real stores, real production CSS — the IPC
// boundary is a permissive stub that answers unknown commands with a safe
// empty value and records them, because dialogs and the workbench reach far
// more commands than a whitelist would name and a throw would abort the shot
// halfway through.
//
// Pictures for a human, numbers for the machine. Each popover scene also runs
// the reusable audit in layout-audit.mjs, and its measured geometry, row
// rhythm, status-bar trigger metrics and text contrast land in the manifest
// under `layout`. A missing selector stays a warning, so one absent surface
// does not cost the others; a failed layout assertion is objective evidence of
// a regression and turns the run red.
//
// Boundaries: the stubbed IPC proves nothing about WebView2, GPU renderers,
// real servers or other platforms' engines. It proves what the front end
// draws given the state the store is handed.
import { build } from "vite";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditLayout } from "./layout-audit.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsArg = process.argv[2] ?? "";
if (!/^[a-z0-9-]+$/.test(resultsArg)) {
  console.error("usage: node scripts/check-refinement-shots.mjs <results-name>");
  process.exit(2);
}
const outDir = path.join(repoRoot, ".tmp", "records", "refinement-shots", resultsArg);
const buildDir = path.join(repoRoot, ".tmp", "refinement-shots-build", `dist-${resultsArg}`);
// Optional copies of the earlier tab component and stylesheet let a visual
// comparison keep all other source, fixture data and viewport settings equal.
const tabBaselineDir = process.env.REFINEMENT_TAB_BASELINE_DIR?.trim();

// The fixture entry: the real App over the permissive stub, with helpers the
// driver uses to put the stores into each state before a shot.
const entryId = "\0refinement-shots-fixture.js";
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from ${JSON.stringify(path.join(repoRoot, "src/App.tsx"))};
import { useStore } from ${JSON.stringify(path.join(repoRoot, "src/store.ts"))};
import { useWorkbench } from ${JSON.stringify(path.join(repoRoot, "src/workbench/store.ts"))};
import { useFileTransfers } from ${JSON.stringify(path.join(repoRoot, "src/fileTransfers.ts"))};
import ${JSON.stringify(path.join(repoRoot, "src/styles.css"))};

const calls = [], unknown = [];

// Synthetic host vitals: each sample moves a little, so the resource
// popover's sparklines have a trend to draw instead of a flat line. The
// field names follow ResourceMetrics (GPU and NPU both present).
let sampleTick = 0;
const resourceSample = () => {
  const phase = [
    { cpu: 18.2, memory: 0.41, down: 812000, up: 96000, gpu: 31 },
    { cpu: 22.9, memory: 0.43, down: 1940000, up: 143000, gpu: 44 },
    { cpu: 15.6, memory: 0.42, down: 642000, up: 51000, gpu: 27 },
    { cpu: 27.4, memory: 0.46, down: 2680000, up: 388000, gpu: 63 },
    { cpu: 20.1, memory: 0.44, down: 1210000, up: 205000, gpu: 38 },
  ][sampleTick++ % 5];
  const totalMemory = 33554432000;
  return {
    status: "ok",
    cpuPercent: phase.cpu, cpuStatus: "ok",
    memory: { usedBytes: totalMemory * phase.memory, totalBytes: totalMemory }, memoryStatus: "ok",
    capacity: { usedBytes: 348966912000, totalBytes: 512110190592, mount: "/" }, capacityStatus: "ok",
    diskReadBps: 1887436, diskWriteBps: 524288, diskStatus: "ok",
    networkReceiveBps: phase.down, networkSendBps: phase.up, networkStatus: "ok",
    gpus: [{ index: 0, name: "NVIDIA GeForce RTX 4090", utilization: phase.gpu,
      usedBytes: 5368709120, totalBytes: 25769803776, temperature: 64 }],
    gpuStatus: "ok",
    npus: [{ index: 0, name: "Ascend 910B", utilization: phase.cpu + 12,
      usedBytes: 9663676416, totalBytes: 67108864000, temperature: 58 }],
    npuStatus: "ok",
  };
};

// One queue covering the states the transfer popover lays out: a running
// upload under a rate limit, a failed upload with per-file reasons, and a
// completed download.
const transferOptions = { requests: 4, chunkKib: 256, files: 2, durable: false, tar: false, rateLimitBps: 0 };
const route = (local, remote, upload = true, itemCount = 1) => ({
  direction: upload ? "upload" : "download", firstUpload: upload, local, remote,
  server: "dev@build-box:22", protocol: "SFTP", itemCount,
});
const transferJobs = [
  { revision: 7, id: "shot-transfer-running", sessionId: "shot-ssh",
    name: "artifacts/edge-1.2.6-x64.tar.zst", status: "running", phase: "upload",
    context: route("C:/build/artifacts/edge-1.2.6-x64.tar.zst", "/work/releases/edge-1.2.6-x64.tar.zst", true, 9),
    transferred: 26214400, total: 58720256, completedFiles: 4, totalFiles: 9,
    failedFiles: [], error: null, attempt: 1,
    options: Object.assign({}, transferOptions, { rateLimitBps: 8388608 }) },
  { revision: 2, id: "shot-transfer-queued", sessionId: "shot-ssh",
    name: "docs/site-2026-11.zip", status: "queued", phase: "upload",
    context: route("C:/build/docs/site-2026-11.zip", "/work/site/site-2026-11.zip", true, 3),
    transferred: 0, total: 73400320, completedFiles: 0, totalFiles: 3,
    failedFiles: [], error: null, attempt: 0,
    options: Object.assign({}, transferOptions, { files: 3 }) },
  { revision: 4, id: "shot-transfer-failed", sessionId: "shot-ssh",
    name: "models/vfi-weights.bin", status: "error", phase: "upload",
    context: route("C:/models/vfi-weights.bin", "/work/models/vfi-weights.bin"),
    transferred: 1073741824, total: 4294967296, completedFiles: 0, totalFiles: 1,
    failedFiles: ["models/vfi-weights.bin: permission denied (os error 13)",
      "models/vfi-weights.bin.part: no space left on device"],
    error: { code: "sftp", message: "Permission denied", retryable: true }, attempt: 3,
    options: Object.assign({}, transferOptions, { files: 1 }) },
  { revision: 12, id: "shot-transfer-complete", sessionId: "shot-ssh",
    name: "logs/2026-10-15.tar.gz", status: "complete", phase: "download",
    context: route("C:/logs/2026-10-15.tar.gz", "/work/logs/2026-10-15.tar.gz", false),
    transferred: 187695104, total: 187695104, completedFiles: 1, totalFiles: 1,
    failedFiles: [], error: null, attempt: 1,
    options: Object.assign({}, transferOptions, { files: 1 }) },
];
const senderCommands = [
  { id: "shot-status", name: "System status", text: "uptime", ending: "lf", scope: { type: "global" } },
  { id: "shot-disk", name: "Disk usage", text: "df -h", ending: "lf", scope: { type: "global" } },
  { id: "shot-logs", name: "Recent application logs", text: "journalctl -u app -n 50", ending: "lf", scope: { type: "global" } },
];

// A local forward and a dynamic (SOCKS5) one: the two shapes the tunnel
// cards render differently.
const tunnelRows = [
  { id: "shot-tunnel-local", owner: "shot-ssh", address: "10.0.0.5:22",
    spec: { direction: "local", listenHost: "127.0.0.1", listenPort: 5432,
      targetHost: "10.0.0.9", targetPort: 5432 },
    status: "listening", error: null, connections: 3, sentBytes: 1867000, receivedBytes: 24118000 },
  { id: "shot-tunnel-dynamic", owner: "shot-ssh", address: "10.0.0.5:22",
    spec: { direction: "dynamic", listenHost: "127.0.0.1", listenPort: 1080,
      targetHost: null, targetPort: null },
    status: "listening", error: null, connections: 7, sentBytes: 941000, receivedBytes: 6204000 },
];
const discoveredPorts = { status: "ok", truncated: false, ports: [
  { host: "0.0.0.0", port: 8000, process: "python3" },
  { host: "127.0.0.1", port: 5432, process: "postgres" },
  { host: "::", port: 6379, process: "redis-server" },
] };
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback() { return ++serial; },
  unregisterCallback() {},
  async invoke(command, args) {
    calls.push({ command, args });
    if (command === "plugin:event|listen") return ++serial;
    if (command === "plugin:event|unlisten") return;
    if (command === "list_workspace_data") return { workspaces: [], experiments: [], runs: [] };
    if (command === "list_sender_commands") return senderCommands;
    if (command === "local_list" || command === "sftp_list") {
      return { path: args?.path ?? "/synthetic", entries: [], truncated: false, source: "stub" };
    }
    if (command === "local_home" || command === "sftp_home") return "/synthetic";
    if (command === "system_monospace_family") return null;
    if (command === "portable_mode") return false;
    if (command === "local_hostname") return "synthetic-host";
    // The three status popovers' own sources: host vitals, the transfer
    // queue, the tunnel list, and the port discovery the tunnel form starts
    // when it opens.
    if (command === "sample_resources") return resourceSample();
    if (command === "cancel_resource_sample") return;
    if (command === "list_file_transfers") return transferJobs;
    if (command === "list_port_forwards") return tunnelRows;
    if (command === "discover_listening_ports") return discoveredPorts;
    if (command === "cancel_port_discovery") return;
    if (command === "plugin:app|version") return "1.0.0";
    if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
    if (command === "plugin:updater|check") return null;
    if (["set_startup_theme", "show_main_window", "finish_main_window",
         "plugin:window|set_title", "plugin:window|set_focus"].includes(command)) return;
    // Anything else: answer with a safe empty value rather than throwing, so a
    // dialog or the workbench can reach a command this fixture never
    // anticipated. A command whose name starts with "list_" is answered with
    // an empty array because every caller treats its result as a collection —
    // returning null there crashed the Sender's library on
    // savedCommands.filter(...) and took the whole React tree down with it,
    // which showed up as six black screens.
    unknown.push({ command, args });
    return command.startsWith("list_") ? [] : null;
  },
};

// A live local session, so the status bar has session details to show and the
// workbench has something to call connected. The pane id is read from the
// store rather than written literally: ROOT_PANE_ID is generated, not "root".
const paneId = useStore.getState().panes[0]?.id ?? "pane-1";
const localTab = {
  info: { id: "shot-session", profileId: null, name: "Local Shell", kind: "local",
    protocol: "local", address: "", color: "", supportsRemoteFiles: false,
    recording: null, legacyAlgorithms: [], sharedConnection: false },
  profile: { id: "", name: "Local Shell", kind: "local" },
  number: 1, ordinal: 0, state: "connected", commandActivity: "idle",
  activityKind: "command", cols: 120, rows: 30, paneId,
};
// An SSH session bound to the synthetic project's server, which is what makes
// the workbench's ExplorerPanel count as connected.
const sshTab = {
  info: { id: "shot-ssh", profileId: "shot-profile", name: "build-box", kind: "ssh",
    protocol: "ssh", address: "10.0.0.5:22", color: "#6ea8fe", supportsRemoteFiles: true,
    recording: null, legacyAlgorithms: [], sharedConnection: false },
  profile: { id: "shot-profile", name: "build-box", kind: "ssh", username: "dev" },
  number: 2, ordinal: 0, state: "connected", commandActivity: "idle",
  activityKind: "command", cols: 120, rows: 30, paneId,
};

const project = {
  id: "shot-project", name: "edge", server: { profileId: "shot-profile", name: "build-box",
    host: "10.0.0.5", port: 22, username: "dev" },
  root: "/work/edge", env: "", commands: [], runRoot: "/work/edge",
  baselineExperimentId: "shot-baseline", createdAt: 1700000000000, updatedAt: 1700000000000,
};
const baseline = {
  id: "shot-baseline", workspaceId: "shot-project", name: "baseline", kind: "baseline",
  baselineId: null, root: null, branch: "main", notes: "",
  createdAt: 1700000000000, updatedAt: 1700000000000,
};
const treeFiles = [
  "Cargo.toml", "README.md", "package.json",
  "src/main.ts", "src/store.ts", "src/terminal.ts",
  "src/components/StatusBar.tsx", "src/components/TabStrip.tsx",
  "src/components/panels/FilerPanel.tsx", "src/components/panels/SenderPanel.tsx",
  "src/styles/foundation.styles.css", "src/styles/sender.styles.css",
  "docs/engineering-standards.zh-CN.md", "docs/test-plan.zh-CN.md",
];

useStore.setState({
  language: "en", gpuRenderer: false, suggestionsEnabled: false,
  tabs: [localTab], activeId: localTab.info.id,
  panes: [{ id: paneId, activeTabId: localTab.info.id }], activePaneId: paneId,
  panels: { sessions: true, sender: true, filer: true },
  panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
});
useWorkbench.setState({ view: "terminals", status: "ready" });

const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(App)));
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

window.__refinement = {
  calls, unknown,
  async terminal(patch) { flushSync(() => useStore.setState(patch)); await frames(); },
  async workbench(patch) { flushSync(() => useWorkbench.setState(patch)); await frames(); },
  async tabs(list) { flushSync(() => useStore.setState({ tabs: list })); await frames(); },
  async frames() { await frames(); },
  /** A mix of background agents, a finished turn and a disconnected tab. */
  async multiTabs() {
    const extra = [
      ["api", "OpenCode api", "connected", "running", "#4ea1f3"],
      ["web", "OpenCode web", "connected", "running", "#bc8cff"],
      ["docs", "OpenCode docs", "connected", "complete", "#39c5cf"],
      ["worker", "Worker", "error", "idle", "#f0883e"],
    ].map(([id, name, state, commandActivity, color], index) => ({
      ...localTab, info: { ...localTab.info, id, name, color },
      profile: { ...localTab.profile, id, name }, number: index + 2,
      state, commandActivity, activityKind: "ai",
    }));
    flushSync(() => useStore.setState({ tabs: [localTab, ...extra], activeId: localTab.info.id,
      panes: [{ id: paneId, activeTabId: localTab.info.id }] }));
    await frames();
  },
  /** Activates the connected SSH tab: the session all three status popovers
      describe (host vitals, transfers, tunnels). */
  async ssh() {
    flushSync(() => useStore.setState({ tabs: [localTab, sshTab], activeId: sshTab.info.id,
      panes: [{ id: paneId, activeTabId: sshTab.info.id }] }));
    await frames();
  },
  /** The theme is store state; App publishes it as data-theme on <html>. */
  async theme(mode) {
    flushSync(() => useStore.setState({ theme: mode }));
    await frames();
  },
  /** Two growing snapshots of the running upload: one snapshot alone leaves
      its bytes-per-second at 0, which is not what a live queue shows. */
  async transferPulse() {
    const current = useFileTransfers.getState().jobs["shot-transfer-running"];
    if (!current) return;
    const move = (transferred, revision) => {
      const next = Object.assign({}, current, { transferred, revision });
      delete next.bytesPerSecond;
      delete next.sampledAt;
      flushSync(() => useFileTransfers.getState().update(next));
    };
    move(current.transferred + 4194304, current.revision + 1);
    await new Promise((resolve) => setTimeout(resolve, 260));
    move(current.transferred + 8388608, current.revision + 2);
    await frames();
  },
  /** Puts the workbench into a connected project with a file tree on screen. */
  async workbenchTree() {
    flushSync(() => useStore.setState({ tabs: [localTab, sshTab], activeId: sshTab.info.id,
      panes: [{ id: paneId, activeTabId: sshTab.info.id }] }));
    flushSync(() => useWorkbench.setState({
      view: "workbench", status: "ready",
      data: { workspaces: [project], experiments: [baseline], runs: [] },
      activeWorkspaceId: project.id, activeExperimentId: baseline.id, activeRunId: null,
      files: { [project.id + ":" + project.root]: { root: project.root, files: treeFiles, truncated: false, source: "stub" } },
      filesErrors: {}, git: {}, gitErrors: {},
    }));
    await frames();
  },
  /** The workbench with no projects at all — the R6.6 empty-state button. */
  async workbenchEmpty() {
    flushSync(() => useStore.setState({ tabs: [localTab], activeId: localTab.info.id,
      panes: [{ id: paneId, activeTabId: localTab.info.id }] }));
    flushSync(() => useWorkbench.setState({
      view: "workbench", status: "ready",
      data: { workspaces: [], experiments: [], runs: [] },
      activeWorkspaceId: null, activeExperimentId: null, activeRunId: null,
      files: {}, filesErrors: {}, git: {}, gitErrors: {},
    }));
    await frames();
  },
  /** Back to the terminal view with every panel docked. */
  async shell() {
    flushSync(() => useStore.setState({
      tabs: [localTab], activeId: localTab.info.id, panes: [{ id: paneId, activeTabId: localTab.info.id }],
      panels: { sessions: true, sender: true, filer: true },
      panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
    }));
    flushSync(() => useWorkbench.setState({ view: "terminals" }));
    await frames();
  },
  count(selector) { return document.querySelectorAll(selector).length; },
};
await document.fonts.ready;
window.__refinementReady = true;
`;

const shots = [];
const warnings = [];
const errors = [];
const consoleErrors = [];
const badResources = [];
// Geometry, rhythm and contrast numbers per popover scene, plus the assertions
// they broke. A broken assertion here is a real regression, so it turns the
// run red; a surface that is simply absent is the shot's own warning.
const layout = {};
const layoutFailures = [];
let browser;
let server;
let browserVersion = "";
let page = null;
let lastPhase = "start";

try {
  const built = await build({
    root: repoRoot,
    configFile: path.join(repoRoot, "vite.config.ts"),
    logLevel: "warn",
    plugins: [
      {
        name: "refinement-shots-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "refinement-shots-fixture-entry") return entryId;
        },
        load(id) {
          if (id === entryId) return entry;
          if (!tabBaselineDir) return;
          const normalized = id.split("?", 1)[0].replaceAll("\\", "/");
          if (normalized.endsWith("/src/components/TabStrip.tsx")) {
            return fs.readFile(path.join(tabBaselineDir, "TabStrip.tsx"), "utf8");
          }
          if (normalized.endsWith("/src/styles/tabs.styles.css")) {
            return fs.readFile(path.join(tabBaselineDir, "tabs.styles.css"), "utf8");
          }
        },
      },
    ],
    build: {
      outDir: buildDir,
      emptyOutDir: false,
      rollupOptions: { input: "refinement-shots-fixture-entry" },
    },
  });
  void built;
  // The build input was a virtual module, so the html is hand-written from
  // whatever the build emitted.
  const distFiles = await fs.readdir(buildDir, { recursive: true });
  const assets = distFiles.filter((name) => /\.(css|js)$/.test(name));
  const entryChunk =
    (Array.isArray(built) ? built[0] : built).output.find(
      (item) => item.type === "chunk" && item.isEntry,
    )?.fileName ?? assets.find((name) => name.endsWith(".js"));
  if (!entryChunk) throw new Error("entry chunk not found in build output");
  const cssLinks = assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => `<link rel="stylesheet" href="/${name.split(path.sep).join("/")}">`)
    .join("");
  await fs.writeFile(
    path.join(buildDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
      `${cssLinks}</head>` +
      `<body><div id="root"></div><script type="module" src="/${entryChunk.split(path.sep).join("/")}"></script></body></html>`,
  );

  const mime = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const target = path.resolve(buildDir, `.${name === "/" ? "/index.html" : name}`);
      if (path.relative(buildDir, target).startsWith("..")) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await fs.readFile(target);
      res.writeHead(200, {
        "content-type": mime[path.extname(target)] ?? "application/octet-stream",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { chromium } = require("playwright");
  const channel = process.env.PERF_BROWSER?.trim() || "chromium";
  browser = await chromium.launch(
    channel === "chromium" ? { headless: true } : { channel, headless: true },
  );
  browserVersion = browser.version();
  page = await browser.newPage({ locale: "en", viewport: { width: 1100, height: 720 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      badResources.push({ status: response.status(), url: response.url() });
  });

  lastPhase = "load";
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__refinementReady === true, undefined, {
    timeout: 30000,
  });

  const call = (method, ...args) =>
    page.evaluate(([method, args]) => window.__refinement[method](...args), [method, args]);
  const count = (selector) => call("count", selector);
  const wait = (ms) => page.waitForTimeout(ms);

  /**
   * Clicks the first of several candidate triggers that is on screen. The
   * feature engineers own their status-bar buttons, so a scene names the
   * wrapper class the shell already styles and the expanded-state attribute
   * the shell promises, and falls back to any button in that wrapper.
   */
  const clickFirst = async (selectors, timeout = 5000) => {
    for (const selector of selectors) {
      const target = page.locator(selector).first();
      if ((await target.count()) > 0) {
        await target.click({ timeout });
        return selector;
      }
    }
    throw new Error(`none of ${selectors.join(", ")} is on screen`);
  };

  /**
   * Closes the shared popover through its own control and waits for the
   * detach: a pointer-outside click only proves the dismiss hook, while the
   * frame's close button is the control the three surfaces promise. A
   * surface that has not migrated to the shared frame yet answers Escape,
   * so the next scene never inherits a panel covering it.
   */
  const closePopover = async () => {
    if ((await page.locator(".status-popover").count()) > 0) {
      try {
        await page.locator(".status-popover-close").first().click({ timeout: 3000 });
        await page.waitForSelector(".status-popover", { state: "detached", timeout: 3000 });
        return;
      } catch (error) {
        warnings.push({ shot: lastPhase, missing: `popover did not close: ${error.message}` });
      }
    }
    await page.keyboard.press("Escape");
    await wait(150);
  };

  // The fixture's module scope runs before React mounts, so "ready" only means
  // the entry evaluated — not that the tree survived it. A render crash leaves
  // every later shot black, which is far cheaper to catch here than to infer
  // from six sets of missing selectors.
  const mounted = await count(".app");
  if (mounted === 0) {
    throw new Error(
      "the App did not mount: the React tree crashed during the first render. " +
        "Check errors/consoleErrors in the manifest — a stub returning the wrong " +
        "shape for a command the tree calls on mount is the usual cause.",
    );
  }

  /**
   * One shot: run its setup, wait for the surface it is meant to show, and
   * record what was actually there. A missing surface is a warning so the
   * remaining shots still run.
   *
   * A modal left open by an earlier shot covers everything behind it while
   * every selector still counts as present, so the counts alone cannot see the
   * occlusion. Unless the shot is itself about a dialog, a standing dialog is
   * reported as a warning.
   */
  const shoot = async (name, setup, expect) => {
    lastPhase = name;
    if (setup) await setup();
    await wait(250);
    const found = {};
    for (const [label, selector] of Object.entries(expect)) {
      found[label] = await count(selector);
      if (found[label] === 0) {
        warnings.push({ shot: name, missing: label, selector });
      }
    }
    if (!expect.dialog && (await count("dialog[open]")) > 0) {
      warnings.push({
        shot: name,
        missing: "a modal dialog is still open and covers this shot",
      });
    }
    const file = path.join(outDir, `${name}.png`);
    await fs.mkdir(outDir, { recursive: true });
    await page.screenshot({ path: file });
    shots.push({ name, file: path.relative(repoRoot, file), found });
  };

  /**
   * Measures the still-open popover and the status bar for the manifest. The
   * numbers are the objective half of the screenshot review: viewport
   * margins, body overflow, row fit and pitch, trigger geometry and text
   * contrast. A failed assertion is recorded under `layout` and fails the run;
   * a missing frame only records why it could not be measured, because the
   * shot's own selector warnings already name that surface.
   */
  const auditScene = async (name, options) => {
    try {
      const record = await auditLayout(page, { scene: name, ...options });
      layout[name] = record;
      for (const failure of record.failures) {
        warnings.push({ shot: name, missing: `layout: ${failure}` });
      }
      if (record.failures.length > 0) {
        layoutFailures.push({ scene: name, failures: record.failures });
      }
      for (const item of record.contrast) {
        if (item.present && item.measured === false) {
          warnings.push({
            shot: name,
            missing: `layout: colour could not be parsed for ${item.selector}`,
          });
        }
      }
      if (record.note) warnings.push({ shot: name, missing: `layout: ${record.note}` });
    } catch (error) {
      warnings.push({ shot: name, missing: `layout audit failed: ${error.message}` });
    }
  };

  // 1. The app shell: session tree, Filer, Sender quickbar and the status bar
  //    with a live session's details.
  await shoot("shell", () => call("shell"), {
    sessionTree: ".panel-body[role=tree]",
    filerList: ".filer-list",
    senderQuickbar: ".sender-quickbar",
    statusbar: ".statusbar",
    statusGroup: ".status-group",
    panelHeaderRule: ".panel-header",
  });

  await shoot("multi-tabs", () => call("multiTabs"), {
    running: ".tab.is-command-running",
    complete: ".tab.is-command-complete",
    error: ".tab.is-error",
  });
  await shoot(
    "multi-tabs-menu",
    async () => {
      const button = page.locator('.tabstrip-actions button[aria-haspopup="menu"]');
      const rect = await button.boundingBox();
      if (!rect) throw new Error("all-sessions button is not visible");
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.waitForSelector(".tab-list-menu", { timeout: 5000 });
    },
    { list: ".tab-list-menu", items: ".tab-list-menu [role=menuitemradio]" },
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 560 });
  await call("theme", "light");
  await shoot("multi-tabs-narrow-light", () => call("multiTabs"), {
    running: ".tab.is-command-running",
    complete: ".tab.is-command-complete",
    error: ".tab.is-error",
  });
  await page.setViewportSize({ width: 1100, height: 720 });
  await call("theme", "dark");
  await call("shell");

  /**
   * Dismisses whatever dialog is open and proves it is gone. A click is not a
   * close: the primitive owns the top layer, and a dialog left standing covers
   * the next shot while every selector behind it still counts as present — the
   * DOM counts cannot see that. So the detach is waited for, and when the
   * dialog will not go the page is reloaded: the fixture replays the store
   * state on every load, so a reload lands on the clean terminal view.
   */
  const dismissDialog = async () => {
    if ((await page.locator("dialog[open]").count()) === 0) return;
    try {
      await page
        .locator("dialog[open] .btn", { hasText: "Cancel" })
        .first()
        .click({ timeout: 3000 });
      await page.waitForSelector("dialog[open]", { state: "detached", timeout: 3000 });
      return;
    } catch {
      // The press missed or the dialog refused it; fall through to the reload.
    }
    try {
      await page.locator("dialog[open]").press("Escape", { timeout: 2000 });
      await page.waitForSelector("dialog[open]", { state: "detached", timeout: 2000 });
      return;
    } catch {
      // Still open.
    }
    await page.reload();
    await page.waitForFunction(() => window.__refinementReady === true, undefined, {
      timeout: 30000,
    });
    await call("shell");
  };

  // 2. The session editor — the largest dialog, and the one W3's control
  //    sizing and radius work lands in. The button is pressed for real rather
  //    than through a synthetic event, and the dialog is lazy so the wait has
  //    to cover its chunk arriving.
  await shoot(
    "session-dialog",
    async () => {
      try {
        await page
          .getByRole("button", { name: "New session", exact: true })
          .click({ timeout: 5000 });
        await page.waitForSelector(".session-dialog", { timeout: 15000 });
      } catch (error) {
        warnings.push({ shot: "session-dialog", missing: `dialog did not open: ${error.message}` });
      }
    },
    {
      dialog: ".session-dialog",
      sessionField: ".session-field",
      section: ".session-section",
      primaryButton: ".btn.is-primary",
    },
  );

  // 3. Display Settings — the dialog with its own multi-column grid, which
  //    §6.2.1 says keeps that layout. Reached through the real menubar. The
  //    session editor is dismissed through its own Cancel button rather than
  //    Escape: a native modal owns the top layer, so a key sent to whatever
  //    happens to hold focus never reaches the dialog that would answer it.
  await shoot(
    "display-settings",
    async () => {
      try {
        await page
          .locator(".session-dialog .btn", { hasText: "Cancel" })
          .first()
          .click({ timeout: 5000 });
        await page.waitForSelector(".session-dialog", { state: "detached", timeout: 5000 });
      } catch (error) {
        warnings.push({
          shot: "display-settings",
          missing: `could not dismiss the session editor: ${error.message}`,
        });
      }
      try {
        // Display Settings lives in the View menu, not Help.
        await page.getByRole("menuitem", { name: "View", exact: true }).click({ timeout: 5000 });
        await page
          .locator(".menu-dropdown .menu-entry", { hasText: "Display Settings" })
          .first()
          .click({ timeout: 5000 });
        await page.waitForSelector(".font-size-dialog", { timeout: 10000 });
      } catch (error) {
        warnings.push({
          shot: "display-settings",
          missing: `dialog did not open: ${error.message}`,
        });
      }
    },
    {
      dialog: ".font-size-dialog",
      setting: ".font-size-setting",
    },
  );

  // The dialog is the subject of the shot above, so it has to be gone before
  // the next one: a modal left standing covers the workbench while every
  // selector behind it still counts as present.
  await dismissDialog();

  // 4. The workbench with no projects. Workbench replaces its whole body with
  //    the onboarding hero in this state, so the sidebar — and any note inside
  //    it — is not on screen; the hero's own create button is the action here.
  await shoot("workbench-empty", () => call("workbenchEmpty"), {
    workbench: ".wb",
    onboarding: ".wb-onboarding",
    createFirst: ".wb-onboarding .btn.is-primary",
  });

  // 5. The workbench with a connected project — the ExplorerPanel file tree
  //    R6.1 gave keyboard navigation.
  await shoot("workbench-tree", () => call("workbenchTree"), {
    workbench: ".wb",
    tree: ".wb-tree",
    treeitem: '[role="treeitem"]',
    dirRow: ".wb-dir-row",
    fileRow: ".wb-file-row",
    sidebar: ".wb-sidebar",
  });

  // 6. The Sender expanded — the compose row and the command library.
  await shoot(
    "sender-expanded",
    async () => {
      await call("shell");
      // The expanded/collapsed choice is read from localStorage once at mount,
      // so the panel has to be remounted to see the other state.
      await page.evaluate(() =>
        localStorage.setItem(
          "edgeterm.panelSizing",
          JSON.stringify({
            left: 260,
            right: 320,
            bottom: 300,
            senderExpanded: true,
          }),
        ),
      );
      await page.reload();
      await page.waitForFunction(() => window.__refinementReady === true, undefined, {
        timeout: 30000,
      });
      await call("shell");
    },
    {
      compose: ".sender-compose",
      textarea: ".sender-command-input",
      library: ".sender-library",
      saveButton: ".sender-save-btn",
    },
  );

  // 7. Host resources on the connected SSH session. The vitals cluster polls
  //    the sampling stub, so a few samples land before the popover opens and
  //    its sparklines have a trend rather than one point. The Sender expansion
  //    from the previous scene is dropped first: these shots review the
  //    popover against the shell's normal proportions, not an expanded panel.
  await shoot(
    "monitor",
    async () => {
      try {
        await page.evaluate(() => localStorage.removeItem("edgeterm.panelSizing"));
        await page.reload();
        await page.waitForFunction(() => window.__refinementReady === true, undefined, {
          timeout: 30000,
        });
        await call("ssh");
        await wait(4600);
        await clickFirst([
          ".resource-monitor button[aria-expanded]",
          ".resource-monitor button",
          ".resource-summary",
        ]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "monitor",
          missing: `resource popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.monitor-popover",
      head: ".status-popover-head",
      body: ".status-popover-body",
      tiles: ".monitor-grid .monitor-tile",
      sparkline: ".monitor-grid .monitor-spark",
      devices: ".monitor-devices",
    },
  );
  await auditScene("monitor", {
    rowGroups: [
      { selector: ".monitor-tile", fit: true },
      { selector: ".monitor-device", fit: true },
      { selector: ".monitor-controls", fit: true },
    ],
    containers: [".status-popover-body", ".monitor-grid", ".monitor-devices"],
    contrast: [
      ".monitor-tile-label",
      ".monitor-tile-value",
      ".monitor-tile-detail",
      ".monitor-device-kind",
      ".monitor-device-name",
      ".monitor-device-value",
      ".monitor-device-meta",
    ],
  });
  await closePopover();

  // 7b. The same monitor surface at 1440x900, above the 1100px breakpoint:
  //     the compact fallback must be gone and the vitals cluster must be what
  //     the bar shows, with every vital inside the 24px strip and the four
  //     gauges keeping their row pitch. The 1100x720 scene above stays as the
  //     compact-breakpoint evidence.
  await page.setViewportSize({ width: 1440, height: 900 });
  await shoot(
    "monitor-wide",
    async () => {
      try {
        await call("ssh");
        await wait(600);
        await clickFirst([
          ".resource-monitor button[aria-expanded]",
          ".resource-monitor button",
          ".resource-summary",
        ]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "monitor-wide",
          missing: `resource popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.monitor-popover",
      vitals: ".resource-vitals",
      wide: ".resource-wide",
    },
  );
  await auditScene("monitor-wide", {
    rowGroups: [
      { selector: ".monitor-tile", fit: true, count: 4, rowPitch: true, pitch: 100.1 },
      { selector: ".monitor-device", fit: true },
      { selector: ".monitor-controls", fit: true },
    ],
    containers: [".status-popover-body", ".monitor-grid", ".monitor-devices"],
    elements: {
      visible: [".resource-wide"],
      hidden: [".resource-compact"],
      fitWithin: [
        { selector: ".resource-vitals", within: ".statusbar" },
        { selector: ".vital", within: ".statusbar", maxHeight: 24 },
      ],
    },
    contrast: [
      ".monitor-tile-label",
      ".monitor-tile-value",
      ".monitor-tile-detail",
      ".monitor-device-kind",
      ".monitor-device-name",
      ".monitor-device-value",
      ".monitor-device-meta",
    ],
  });
  await closePopover();
  await page.setViewportSize({ width: 1100, height: 720 });

  // 8. The transfer queue: a running upload, a failed upload with failed
  //    files, and a completed download, all seeded through list_file_transfers.
  await shoot(
    "transfers",
    async () => {
      try {
        await call("ssh");
        await call("transferPulse");
        await clickFirst([".transfer-center button[aria-expanded]", ".transfer-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "transfers",
          missing: `transfer popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.transfer-center-popover",
      head: ".status-popover-head",
      body: ".status-popover-body",
      jobRows: ".status-popover .transfer-job",
      statusPill: ".status-popover .transfer-status",
      progress: ".status-popover .transfer-job-track",
      failedFilesToggle: ".status-popover .transfer-job-failures",
    },
  );
  await auditScene("transfers", {
    rowGroups: [{ selector: ".transfer-job", fit: true, pitch: 100 }],
    containers: [".status-popover-body", ".transfer-center-jobs"],
    contrast: [".transfer-status", ".transfer-job-name", ".transfer-job-meta-text"],
  });
  await closePopover();

  // A long route is opened through the actual row control. This captures the
  // selectable detail as well as the truncated summary it expands from.
  await shoot(
    "transfers-route-detail",
    async () => {
      try {
        await call("ssh");
        await clickFirst([".transfer-center button[aria-expanded]", ".transfer-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
        await page
          .locator(".status-popover .transfer-job-context")
          .first()
          .click({ timeout: 4000 });
        await page.waitForSelector(".transfer-detail-text", { timeout: 4000 });
      } catch (error) {
        warnings.push({
          shot: "transfers-route-detail",
          missing: `route detail did not open: ${error.message}`,
        });
      }
    },
    { details: ".transfer-detail-text", context: ".transfer-job-context" },
  );
  await closePopover();

  // 8b. The failed files behind the queue's failed row: the toggle opens the
  //     per-file reasons, which is the evidence the row alone cannot carry.
  await shoot(
    "transfers-failed",
    async () => {
      try {
        await call("ssh");
        await clickFirst([".transfer-center button[aria-expanded]", ".transfer-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
        await page
          .locator(".status-popover .transfer-job-failures")
          .first()
          .click({ timeout: 4000 });
        await page
          .locator(".status-popover .transfer-failures")
          .scrollIntoViewIfNeeded({ timeout: 4000 });
      } catch (error) {
        warnings.push({
          shot: "transfers-failed",
          missing: `failed-file list did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.transfer-center-popover",
      failures: ".status-popover .transfer-failures",
      failureRows: ".status-popover .transfer-failure-row",
    },
  );
  await auditScene("transfers-failed", {
    rowGroups: [
      { selector: ".transfer-job", fit: true, pitch: 100 },
      { selector: ".transfer-failure-row", fit: true, pitch: 24 },
    ],
    containers: [".status-popover-body", ".transfer-center-jobs", ".transfer-failure-rows"],
    contrast: [".transfer-status", ".transfer-job-name", ".transfer-job-meta-text"],
  });
  await closePopover();

  // The tunnel surface is measured three times (dark/light, narrow/wide), so
  // its row and contrast expectations live in one object.
  const tunnelAudit = {
    rowGroups: [{ selector: ".forward-job", fit: true, pitchVar: "--forward-job-h" }],
    containers: [".status-popover-body", ".forward-jobs"],
    contrast: [
      ".forward-endpoint-label",
      ".forward-column",
      ".forward-job-status",
      ".forward-job-address",
    ],
  };

  // 9. The tunnel centre: one local forward and one dynamic (SOCKS5) forward,
  //    plus the remote-listener discovery the create form starts on open.
  await shoot(
    "tunnels",
    async () => {
      try {
        await call("ssh");
        await clickFirst([".forward-center button[aria-expanded]", ".forward-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "tunnels",
          missing: `tunnel popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.forward-popover",
      head: ".status-popover-head",
      body: ".status-popover-body",
      createForm: ".status-popover .forward-form",
      tunnelRows: ".status-popover .forward-job",
      route: ".status-popover .forward-route",
      badge: ".status-popover .forward-job-badge",
    },
  );
  await auditScene("tunnels", tunnelAudit);
  await closePopover();

  // 10. The same tunnel surface at 1440x900 in the light theme: the shared
  //     frame has to hold a wide viewport and the second palette, not only
  //     the 1100x720 dark default.
  await page.setViewportSize({ width: 1440, height: 900 });
  await call("theme", "light");
  await shoot(
    "tunnels-wide",
    async () => {
      try {
        await call("ssh");
        await clickFirst([".forward-center button[aria-expanded]", ".forward-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "tunnels-wide",
          missing: `tunnel popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusPopover: ".status-popover.forward-popover",
      head: ".status-popover-head",
      body: ".status-popover-body",
      tunnelRows: ".status-popover .forward-job",
      route: ".status-popover .forward-route",
    },
  );
  await auditScene("tunnels-wide", tunnelAudit);
  await closePopover();

  // 11. The same surface at the shell's smallest supported size (900x560),
  //     back in the dark theme: the frame has to stay inside the viewport and
  //     the status bar has to keep its triggers on screen.
  await page.setViewportSize({ width: 900, height: 560 });
  await call("theme", "dark");
  await shoot(
    "tunnels-narrow",
    async () => {
      try {
        await call("ssh");
        await clickFirst([".forward-center button[aria-expanded]", ".forward-center button"]);
        await page.waitForSelector(".status-popover", { timeout: 8000 });
      } catch (error) {
        warnings.push({
          shot: "tunnels-narrow",
          missing: `tunnel popover did not open: ${error.message}`,
        });
      }
    },
    {
      statusbar: ".statusbar",
      statusPopover: ".status-popover.forward-popover",
      tunnelRows: ".status-popover .forward-job",
    },
  );
  await auditScene("tunnels-narrow", tunnelAudit);
  await closePopover();

  const unknownIpc = await page.evaluate(() => window.__refinement.unknown);
  const manifest = {
    at: new Date().toISOString(),
    browser: browserVersion,
    channel,
    tabSources: tabBaselineDir ? "supplied baseline component and stylesheet" : "current sources",
    scope:
      "Production build (real vite.config). Real App, real stores, real CSS; permissive IPC stub that answers unknown commands with a safe empty value and records them, plus synthetic commands, transfer routes and resource/forward samples. Screenshots at 1100x720 (dark) for the surfaces check-app-font-chain.mjs does not reach: dialogs, the workbench view and the three status-bar popovers (host resources, transfers, tunnels). The monitor-wide scene repeats the host-resources popover at 1440x900 so the vitals cluster itself (not only the compact fallback) is measured; tunnels-wide repeats the tunnel popover at 1440x900 in the light theme; tunnels-narrow does it at 900x560 in the dark theme. The `layout` key carries the measured geometry, row rhythm, status-bar trigger metrics, element-cluster visibility/fit and text-contrast ratios behind those screenshots; a failed layout assertion turns the run red.",
    shots,
    warnings,
    layout,
    layoutFailures,
    unknownIpc,
    errors,
    consoleErrors,
    badResources,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify(
      {
        shots: shots.map(({ name, file }) => ({ name, file })),
        warnings: warnings.length,
        layoutFailures: layoutFailures.length,
        unknownIpc: unknownIpc.length,
        errors: errors.length,
        consoleErrors: consoleErrors.length,
        badResources: badResources.length,
        outDir: path.relative(repoRoot, outDir),
      },
      null,
      2,
    ),
  );
  // Missing surfaces and page errors are reported so a human decides; a failed
  // layout assertion is an objective regression, so it turns the run red.
  if (errors.length > 0 || badResources.length > 0 || layoutFailures.length > 0)
    process.exitCode = 1;
} catch (error) {
  let unknownIpcLate = null;
  try {
    unknownIpcLate = (await page?.evaluate(() => window.__refinement?.unknown)) ?? null;
  } catch {
    /* page already gone */
  }
  const manifest = {
    at: new Date().toISOString(),
    browser: browserVersion,
    lastPhase,
    error: String(error),
    shots,
    warnings,
    layout,
    layoutFailures,
    unknownIpc: unknownIpcLate,
    errors,
    consoleErrors,
    badResources,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error("refinement shots failed:", String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
}
