// Visual evidence for the UI refinement: the surfaces the font-chain gate
// does not reach. Real App, real stores, real production CSS — the IPC
// boundary is a permissive stub that answers unknown commands with a safe
// empty value and records them, because dialogs and the workbench reach far
// more commands than a whitelist would name and a throw would abort the shot
// halfway through.
//
// Unlike check-app-font-chain.mjs this is NOT an oracle: it has no
// expectations to fail. It exists to produce screenshots a human can review,
// plus a manifest of what was actually on screen when each was taken. A
// missing selector is recorded as a warning, not a failure, so one absent
// surface does not cost the others.
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

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsArg = process.argv[2] ?? "";
if (!/^[a-z0-9-]+$/.test(resultsArg)) {
  console.error("usage: node scripts/check-refinement-shots.mjs <results-name>");
  process.exit(2);
}
const outDir = path.join(repoRoot, ".tmp", "records", "refinement-shots", resultsArg);
const buildDir = path.join(repoRoot, ".tmp", "refinement-shots-build", `dist-${resultsArg}`);

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
import ${JSON.stringify(path.join(repoRoot, "src/styles.css"))};

const calls = [], unknown = [];
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
    if (command === "local_list" || command === "sftp_list") {
      return { path: args?.path ?? "/synthetic", entries: [], truncated: false, source: "stub" };
    }
    if (command === "local_home" || command === "sftp_home") return "/synthetic";
    if (command === "system_monospace_family") return null;
    if (command === "portable_mode") return false;
    if (command === "local_hostname") return "synthetic-host";
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
  /** Puts the workbench into a connected project with a file tree on screen. */
  async workbenchTree() {
    flushSync(() => useStore.setState({ tabs: [localTab, sshTab], activeId: sshTab.info.id }));
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
    flushSync(() => useStore.setState({ tabs: [localTab], activeId: localTab.info.id }));
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
      tabs: [localTab], activeId: localTab.info.id,
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
    plugins: [{
      name: "refinement-shots-fixture",
      enforce: "pre",
      resolveId(id) { if (id === "refinement-shots-fixture-entry") return entryId; },
      load(id) { if (id === entryId) return entry; },
    }],
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
  const entryChunk = (Array.isArray(built) ? built[0] : built).output
    .find((item) => item.type === "chunk" && item.isEntry)?.fileName
    ?? assets.find((name) => name.endsWith(".js"));
  if (!entryChunk) throw new Error("entry chunk not found in build output");
  const cssLinks = assets.filter((name) => name.endsWith(".css"))
    .map((name) => `<link rel="stylesheet" href="/${name.split(path.sep).join("/")}">`)
    .join("");
  await fs.writeFile(
    path.join(buildDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
    `${cssLinks}</head>` +
    `<body><div id="root"></div><script type="module" src="/${entryChunk.split(path.sep).join("/")}"></script></body></html>`,
  );

  const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const target = path.resolve(buildDir, `.${name === "/" ? "/index.html" : name}`);
      if (path.relative(buildDir, target).startsWith("..")) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await fs.readFile(target);
      res.writeHead(200, { "content-type": mime[path.extname(target)] ?? "application/octet-stream" });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { chromium } = require("playwright");
  const channel = process.env.PERF_BROWSER?.trim() || "chromium";
  browser = await chromium.launch(channel === "chromium" ? { headless: true } : { channel, headless: true });
  browserVersion = browser.version();
  page = await browser.newPage({ locale: "en", viewport: { width: 1100, height: 720 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResources.push({ status: response.status(), url: response.url() });
  });

  lastPhase = "load";
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__refinementReady === true, undefined, { timeout: 30000 });

  const call = (method, ...args) => page.evaluate(
    ([method, args]) => window.__refinement[method](...args),
    [method, args],
  );
  const count = (selector) => call("count", selector);
  const wait = (ms) => page.waitForTimeout(ms);

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

  /**
   * Dismisses whatever dialog is open and proves it is gone. A click is not a
   * close: the primitive owns the top layer, and a dialog left standing covers
   * the next shot while every selector behind it still counts as present — the
   * DOM counts cannot see that. So the detach is waited for, and when the
   * dialog will not go the page is reloaded: the fixture replays the store
   * state on every load, so a reload lands on the clean terminal view.
   */
  const dismissDialog = async () => {
    if (await page.locator("dialog[open]").count() === 0) return;
    try {
      await page.locator("dialog[open] .btn", { hasText: "Cancel" })
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
    await page.waitForFunction(() => window.__refinementReady === true, undefined, { timeout: 30000 });
    await call("shell");
  };

  // 2. The session editor — the largest dialog, and the one W3's control
  //    sizing and radius work lands in. The button is pressed for real rather
  //    than through a synthetic event, and the dialog is lazy so the wait has
  //    to cover its chunk arriving.
  await shoot("session-dialog", async () => {
    try {
      await page.getByRole("button", { name: "New session", exact: true }).click({ timeout: 5000 });
      await page.waitForSelector(".session-dialog", { timeout: 15000 });
    } catch (error) {
      warnings.push({ shot: "session-dialog", missing: `dialog did not open: ${error.message}` });
    }
  }, {
    dialog: ".session-dialog",
    sessionField: ".session-field",
    section: ".session-section",
    primaryButton: ".btn.is-primary",
  });

  // 3. Display Settings — the dialog with its own multi-column grid, which
  //    §6.2.1 says keeps that layout. Reached through the real menubar. The
  //    session editor is dismissed through its own Cancel button rather than
  //    Escape: a native modal owns the top layer, so a key sent to whatever
  //    happens to hold focus never reaches the dialog that would answer it.
  await shoot("display-settings", async () => {
    try {
      await page.locator(".session-dialog .btn", { hasText: "Cancel" })
        .first()
        .click({ timeout: 5000 });
      await page.waitForSelector(".session-dialog", { state: "detached", timeout: 5000 });
    } catch (error) {
      warnings.push({ shot: "display-settings", missing: `could not dismiss the session editor: ${error.message}` });
    }
    try {
      // Display Settings lives in the View menu, not Help.
      await page.getByRole("menuitem", { name: "View", exact: true }).click({ timeout: 5000 });
      await page.locator(".menu-dropdown .menu-entry", { hasText: "Display Settings" })
        .first()
        .click({ timeout: 5000 });
      await page.waitForSelector(".font-size-dialog", { timeout: 10000 });
    } catch (error) {
      warnings.push({ shot: "display-settings", missing: `dialog did not open: ${error.message}` });
    }
  }, {
    dialog: ".font-size-dialog",
    setting: ".font-size-setting",
  });

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
  await shoot("sender-expanded", async () => {
    await call("shell");
    // The expanded/collapsed choice is read from localStorage once at mount,
    // so the panel has to be remounted to see the other state.
    await page.evaluate(() => localStorage.setItem("edgeterm.panelSizing", JSON.stringify({
      left: 260, right: 320, bottom: 300, senderExpanded: true,
    })));
    await page.reload();
    await page.waitForFunction(() => window.__refinementReady === true, undefined, { timeout: 30000 });
    await call("shell");
  }, {
    compose: ".sender-compose",
    textarea: ".sender-command-input",
    library: ".sender-library",
    saveButton: ".sender-save-btn",
  });

  const unknownIpc = await page.evaluate(() => window.__refinement.unknown);
  const manifest = {
    at: new Date().toISOString(),
    browser: browserVersion,
    channel,
    scope: "Production build (real vite.config). Real App, real stores, real CSS; permissive IPC stub that answers unknown commands with a safe empty value and records them. Screenshots at 1100x720 for visual review of the surfaces check-app-font-chain.mjs does not reach: dialogs and the workbench view.",
    shots,
    warnings,
    unknownIpc,
    errors,
    consoleErrors,
    badResources,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    shots: shots.map(({ name, file }) => ({ name, file })),
    warnings: warnings.length,
    unknownIpc: unknownIpc.length,
    errors: errors.length,
    consoleErrors: consoleErrors.length,
    badResources: badResources.length,
    outDir: path.relative(repoRoot, outDir),
  }, null, 2));
  // Not an oracle: nothing here fails the run. Page errors and missing
  // surfaces are reported so a human decides what they mean.
  if (errors.length > 0 || badResources.length > 0) process.exitCode = 1;
} catch (error) {
  let unknownIpcLate = null;
  try {
    unknownIpcLate = await page?.evaluate(() => window.__refinement?.unknown) ?? null;
  } catch { /* page already gone */ }
  const manifest = {
    at: new Date().toISOString(),
    browser: browserVersion,
    lastPhase,
    error: String(error),
    shots,
    warnings,
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
