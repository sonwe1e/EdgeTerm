import { createElement as h, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import App from "../App";
import { useStore, type Tab } from "../store";
import { clippedTextIssues, targetSizeIssues, textContrastIssues } from "../uiAudit";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * The file lists: dual-pane FTP and the Filer dock share one row rhythm, the
 * sortable captions are full-size targets, and the three measured gates hold on
 * the FTP surface (the shell gate never mounts it).
 *
 * Boundary: Chromium over a controlled IPC stub.
 */

let serial = 0;
const ENTRIES = [
  {
    name: "logs",
    path: "/logs",
    isDir: true,
    isSymlink: false,
    size: 0,
    modified: 1731000000,
    permissions: null,
    owner: null,
    group: null,
  },
  {
    name: "access.log",
    path: "/access.log",
    isDir: false,
    isSymlink: false,
    size: 1048576,
    modified: 1731000000,
    permissions: null,
    owner: null,
    group: null,
  },
  {
    name: "notes.txt",
    path: "/notes.txt",
    isDir: false,
    isSymlink: false,
    size: 42,
    modified: 1731000123,
    permissions: null,
    owner: null,
    group: null,
  },
];
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "sftp_list" || command === "local_list") {
      return { path: String(args.path ?? "/"), entries: ENTRIES };
    }
    if (command === "local_home") return "/home/fixture";
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    if (command === "session_cwd") return "/srv";
    return null;
  },
};

const initial = useStore.getState();
const FTP_ID = "ftp-surfaces";
const SHELL_ID = "shell-surfaces";

const tab = (id: string, kind: "ftp" | "ssh"): Tab => ({
  info: {
    id,
    name: kind,
    kind,
    protocol: kind === "ftp" ? "ftp" : "ssh",
    profileId: null,
    address: kind === "ftp" ? "ftp://fixture" : "build@fixture:22",
    color: null,
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-" + id, name: id, kind },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const until = async (predicate: () => boolean, timeoutMs = 5000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const mountTab = async (kind: "ftp" | "ssh", filer = false) => {
  await page.viewport(1280, 800);
  const id = kind === "ftp" ? FTP_ID : SHELL_ID;
  useStore.setState({
    ...initial,
    tabs: [tab(id, kind)],
    activeId: id,
    panes: [{ id: "root", activeTabId: id }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    panels: { sessions: false, filer, sender: false },
    panelDocks: { left: [], right: ["filer"], bottom: [] },
    gpuRenderer: false,
  });
  useStore.getState().setLanguage("en");
  mount(h(StrictMode, null, h(App)));
  await twoFrames();
  await twoFrames();
  return id;
};

/**
 * The row rhythm the file lists promise, derived independently of the CSS: the
 * Filer's virtualiser formula (FilerPanel `rowHeight`) is the source both lists
 * follow, so the expectation is computed here rather than read back from the
 * token being checked.
 */
const expectedPitch = (): number => Math.max(24, useStore.getState().panelFontSize + 10) + 2;

const show = (issue: { path: string; detail: string; text: string }) =>
  issue.path + " | " + issue.detail + " | " + issue.text;

describe("file lists", () => {
  afterEach(async () => {
    await browserAfterEach();
    useStore.setState(initial, true);
  });

  it("keeps the FTP surface readable, hittable and on the shared row rhythm", async () => {
    await mountTab("ftp");
    await until(() => document.querySelector(".ftp-file-row") !== null);
    await twoFrames();
    const root = document.querySelector<HTMLElement>(".ftp-workspace")!;
    expect(root, "the FTP workspace rendered").not.toBeNull();

    // The three gates, on a surface the shell audit never mounts.
    const contrast = textContrastIssues(root);
    const targets = targetSizeIssues(root);
    const clips = clippedTextIssues(root);
    expect(contrast.issues.map(show), "contrast").toEqual([]);
    expect(targets.issues.map(show), "targets").toEqual([]);
    expect(clips.issues.map(show), "clips").toEqual([]);
    expect(contrast.inspected + contrast.indeterminate, "text inspected").toBeGreaterThan(5);
    expect(targets.inspected, "targets inspected").toBeGreaterThan(2);

    // One row rhythm: the row is exactly the pitch token.
    const row = document.querySelector<HTMLElement>(".ftp-file-row")!;
    expect(row.getBoundingClientRect().height).toBeCloseTo(expectedPitch(), 0);

    // The dual pane has two browsers (local and remote), each with its own
    // caption row. Every caption is a full-size target, not a 13px line of text.
    const browsers = Array.from(document.querySelectorAll<HTMLElement>(".ftp-file-browser"));
    expect(browsers.length, "local and remote browsers").toBe(2);
    for (const browser of browsers) {
      const captions = Array.from(
        browser.querySelectorAll<HTMLElement>(".ftp-browser-columns button"),
      );
      expect(captions.length, "three sortable columns").toBe(3);
      for (const caption of captions) {
        expect(caption.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
      }
      // The sorted column is marked by a rule, and only it: the cue does not
      // depend on reading the arrow.
      const sorted = captions.filter((caption) => caption.classList.contains("is-sorted"));
      expect(sorted.length, "one column is sorted").toBe(1);
      expect(getComputedStyle(sorted[0]).borderBottomWidth).toBe("2px");
      expect(getComputedStyle(sorted[0]).borderBottomColor).not.toBe("rgba(0, 0, 0, 0)");
      for (const caption of captions.filter((node) => node !== sorted[0])) {
        expect(getComputedStyle(caption).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
      }
    }
  });

  it("gives the Filer dock the same rhythm as the dual pane", async () => {
    await mountTab("ssh", true);
    await until(() => document.querySelector(".filer-list .virtual-file-rows > div") !== null);
    await twoFrames();
    const slot = document.querySelector<HTMLElement>(".filer-list .virtual-file-rows > div")!;
    expect(slot, "a Filer row slot").not.toBeNull();
    expect(slot.getBoundingClientRect().height).toBeCloseTo(expectedPitch(), 0);
  });
});
