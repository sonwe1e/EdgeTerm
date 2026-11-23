import { createElement as h, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import App from "../App";
import { useStore } from "../store";
import type { SessionGroup, SessionProfile } from "../types";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import {
  clippedTextIssues,
  targetSizeIssues,
  textContrastIssues,
  type AuditIssue,
} from "../uiAudit";
import "../styles.css";

// Measures the shell the way a reader meets it: real Chromium, real
// stylesheet, synthetic data behind a controlled IPC boundary. Each run
// prints one JSON report per viewport/theme so a visual claim can be traced
// to a number, and the assertions below pin the handful of invariants that
// must never regress.
//
// Tool boundary (scripts/README wording): the components and CSS are the real
// ones; the sessions, listings and IPC replies are fixtures. Nothing here
// proves WebView2 rendering or a real server.

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "list_profiles") return PROFILES;
    if (command === "list_groups") return GROUPS;
    if (command === "local_list" || command === "sftp_list") {
      return { path: String(args.path), entries: FIXTURE_ENTRIES };
    }
    if (command === "local_home" || command === "sftp_home") return "/home/build";
    if (command === "session_cwd") throw new Error("fixture reports directories explicitly");
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    if (command === "sample_resources" || command === "resource_sample") {
      return {
        cpu: 12.5,
        memory: 41_943_040,
        memoryTotal: 16_777_216_000,
        netRx: 1024,
        netTx: 2048,
      };
    }
    return null;
  },
};

const now = 1_700_000_000;
const FIXTURE_ENTRIES = [
  {
    name: "src",
    path: "/home/build/src",
    isDir: true,
    isSymlink: false,
    size: 0,
    modified: now,
    permissions: "drwxr-xr-x",
    owner: "build",
    group: "build",
  },
  {
    name: "dist",
    path: "/home/build/dist",
    isDir: true,
    isSymlink: false,
    size: 0,
    modified: now - 3600,
    permissions: "drwxr-xr-x",
    owner: "build",
    group: "build",
  },
  {
    name: "node_modules",
    path: "/home/build/node_modules",
    isDir: true,
    isSymlink: false,
    size: 0,
    modified: now - 86_400,
    permissions: "drwxr-xr-x",
    owner: "build",
    group: "build",
  },
  {
    name: "deploy.sh",
    path: "/home/build/deploy.sh",
    isDir: false,
    isSymlink: false,
    size: 2048,
    modified: now - 7200,
    permissions: "-rwxr-xr-x",
    owner: "build",
    group: "build",
  },
  {
    name: "README.md",
    path: "/home/build/README.md",
    isDir: false,
    isSymlink: false,
    size: 4096,
    modified: now - 12_000,
    permissions: "-rw-r--r--",
    owner: "build",
    group: "build",
  },
  {
    name: "package.json",
    path: "/home/build/package.json",
    isDir: false,
    isSymlink: false,
    size: 1536,
    modified: now - 40_000,
    permissions: "-rw-r--r--",
    owner: "build",
    group: "build",
  },
  {
    name: "server.log",
    path: "/home/build/server.log",
    isDir: false,
    isSymlink: false,
    size: 12_582_912,
    modified: now - 60,
    permissions: "-rw-r--r--",
    owner: "build",
    group: "build",
  },
];

const PROFILES: SessionProfile[] = [
  {
    id: "p-build",
    name: "Build server",
    kind: "ssh",
    host: "build.internal",
    username: "build",
    port: 22,
  },
  { id: "p-db", name: "prod-db", kind: "ssh", host: "db.internal", username: "root", port: 2222 },
  { id: "p-local", name: "PowerShell", kind: "local", shell: "pwsh.exe" },
  { id: "p-ftp", name: "Files", kind: "sftp", host: "files.internal", username: "build" },
] as SessionProfile[];
const GROUPS: SessionGroup[] = [{ id: "g-prod", name: "Production", kind: "ssh", parentId: null }];

const initial = useStore.getState();

const tabsFor = () => {
  const base = {
    number: 1,
    ordinal: 0,
    state: "connected" as const,
    commandActivity: "idle" as const,
    activityKind: "command" as const,
    paneId: "root",
  };
  return [
    {
      ...base,
      info: {
        id: "t-build",
        profileId: "p-build",
        name: "Build server",
        kind: "ssh" as const,
        protocol: "ssh",
        address: "build@build.internal:22",
        color: null,
        supportsRemoteFiles: true,
        recording: null,
        legacyAlgorithms: [],
        sharedConnection: false,
      },
      profile: PROFILES[0],
    },
    {
      ...base,
      number: 2,
      info: {
        id: "t-local",
        profileId: "p-local",
        name: "PowerShell",
        kind: "local" as const,
        protocol: "local",
        address: "pwsh.exe",
        color: null,
        supportsRemoteFiles: false,
        recording: null,
        legacyAlgorithms: [],
        sharedConnection: false,
      },
      profile: PROFILES[2],
    },
  ];
};

interface Config {
  label: string;
  theme: "dark" | "light" | "serialx-dark" | "serialx-light";
  width: number;
  height: number;
  language: "en" | "zh-CN";
}

const CONFIGS: Config[] = [
  { label: "dark-1440x900-zh", theme: "dark", width: 1440, height: 900, language: "zh-CN" },
  { label: "light-1100x720-en", theme: "light", width: 1100, height: 720, language: "en" },
  {
    label: "serialx-dark-900x560-en",
    theme: "serialx-dark",
    width: 900,
    height: 560,
    language: "en",
  },
];

const describeIssue = (issue: AuditIssue): string =>
  issue.kind + " " + issue.path + " — " + issue.detail + ' — "' + issue.text + '"';

/**
 * The three collectors this gate runs on the mounted shell. The splitter's
 * host element is the 1px sash while its hit area is the 11px ::after it
 * draws (status.styles.css), so target measurement skips it; everything else
 * on screen is fair game.
 */
const auditShell = () => ({
  contrast: textContrastIssues(document.body),
  targets: targetSizeIssues(document.body, { ignore: ".splitter" }),
  clips: clippedTextIssues(document.body),
});

const applyConfig = (config: Config) => {
  useStore.setState(
    {
      ...initial,
      language: config.language,
      theme: config.theme,
      gpuRenderer: false,
      panelFontSize: 12,
      bufferFontSize: 14,
      profiles: PROFILES,
      groups: GROUPS,
      tabs: tabsFor(),
      panes: [{ id: "root", activeTabId: "t-build" }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      activeId: "t-build",
      panels: { sessions: true, sender: false, filer: true },
      panelDocks: { left: ["sessions"], right: ["filer"], bottom: ["sender"] },
      status: "Connected",
      error: null,
    },
    true,
  );
};

const mountShell = async (config: Config) => {
  await page.viewport(config.width, config.height);
  localStorage.clear();
  applyConfig(config);
  mount(h(StrictMode, null, h(App)));
  await twoFrames();
  await twoFrames();
};

/** A real element's box, measured the way the audit measures it. */
const boxOf = (selector: string): DOMRect => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error("fixture is missing " + selector);
  return element.getBoundingClientRect();
};

const tokenPx = (name: string): number => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(name + " is not a length: " + value);
  return parsed;
};

describe("shell visual audit", () => {
  afterEach(async () => {
    await browserAfterEach();
  });

  for (const config of CONFIGS) {
    it(
      "keeps every rendered label readable and every control hittable at " + config.label,
      async () => {
        await mountShell(config);
        const report = auditShell();
        // A named assertion per collector, so a failure says which property
        // broke instead of "the page has a problem".
        expect(report.contrast.issues.map(describeIssue), "text contrast").toEqual([]);
        expect(report.targets.issues.map(describeIssue), "pointer targets").toEqual([]);
        expect(report.clips.issues.map(describeIssue), "clipped labels").toEqual([]);
        // An empty failure list only means something if the collectors saw the
        // chrome: these floors are the count the shell really produces, so a
        // collector that silently stopped inspecting fails the gate too.
        expect(report.contrast.inspected, "text runs inspected").toBeGreaterThan(40);
        expect(report.targets.inspected, "targets inspected").toBeGreaterThan(20);
      },
    );
  }

  it("gives the controls a 24px target and keeps the floating layers ordered", async () => {
    await mountShell(CONFIGS[1]);

    // The breadcrumb trail: every ancestor is a full-height, at-least-24px
    // wide button, including the root "/" whose glyph is 5px.
    const crumbs = Array.from(document.querySelectorAll<HTMLElement>(".filer-crumb"));
    expect(crumbs.length).toBeGreaterThan(0);
    for (const crumb of crumbs) {
      const box = crumb.getBoundingClientRect();
      expect(box.height, 'crumb "' + crumb.textContent + '" height').toBeGreaterThanOrEqual(23.5);
      expect(box.width, 'crumb "' + crumb.textContent + '" width').toBeGreaterThanOrEqual(23.5);
    }

    // The SSH reuse disclosure is a row, not its 14px text line.
    expect(boxOf(".ssh-connection-options summary").height).toBeGreaterThanOrEqual(23.5);

    // Panel-header icon actions and the tab close target use --h-control.
    for (const action of Array.from(document.querySelectorAll<HTMLElement>(".panel-action"))) {
      const box = action.getBoundingClientRect();
      // Row actions are visible only while their row is pointed at, but their
      // box must not change with that state: the glyph animates, not the
      // target.
      expect(box.width, "panel action width").toBeGreaterThanOrEqual(23.5);
      expect(box.height, "panel action height").toBeGreaterThanOrEqual(23.5);
    }
    const close = boxOf(".tab-close");
    expect(close.width, "tab close width").toBeGreaterThanOrEqual(23.5);
    expect(close.height, "tab close height").toBeGreaterThanOrEqual(23.5);

    // The stacking ladder: drag feedback above the status popovers, dialogs
    // above everything transient. These used to share 1000.
    expect(tokenPx("--z-popover")).toBeGreaterThan(tokenPx("--z-hud"));
    expect(tokenPx("--z-drag")).toBeGreaterThan(tokenPx("--z-popover"));
    expect(tokenPx("--z-dialog")).toBeGreaterThan(tokenPx("--z-drag"));
    const ghost = document.createElement("div");
    ghost.className = "tab-drag-ghost";
    document.body.append(ghost);
    expect(getComputedStyle(ghost).zIndex).toBe(String(Math.trunc(tokenPx("--z-drag"))));
    ghost.remove();

    // Every palette declares its own elevation shadows: the serialX dark half
    // used to fall through to the default dark set.
    for (const theme of ["dark", "light", "serialx-dark", "serialx-light"]) {
      document.documentElement.dataset.theme = theme;
      for (const name of ["--shadow-menu", "--shadow-pop", "--scrim"]) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        expect(value.length, theme + " " + name).toBeGreaterThan(0);
      }
    }
  });

  it("would still catch those defects if the fix were undone", async () => {
    await mountShell(CONFIGS[1]);
    // The old box model, restored through the cascade: the gate has to fail on
    // the same tree it just passed, otherwise "no issues" proves nothing.
    const revert = document.createElement("style");
    revert.textContent = [
      ".filer-crumb { min-height: 0 !important; min-width: 0 !important; padding: 0 !important; }",
      ".ssh-connection-options summary { min-height: 0 !important; }",
      ".panel-action { width: 22px !important; height: 22px !important; }",
      ".agent-compose-launch { color: var(--accent-bright) !important; }",
    ].join("\n");
    document.head.append(revert);
    await twoFrames();
    const report = auditShell();
    const targets = report.targets.issues.map(describeIssue);
    expect(targets.length, "reverted hit targets are reported").toBeGreaterThan(0);
    expect(
      report.contrast.issues
        .map(describeIssue)
        .some((line) => line.includes("agent-compose-label")),
      "reverted pill ink is reported",
    ).toBe(true);
    revert.remove();
  });
});
