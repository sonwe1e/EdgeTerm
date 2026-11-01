// Wave B — two layout defects from the 2026-10-20 review, both about surfaces
// assuming things about the window that are not true.
//
// UI-01 — the Filer's three columns were fixed pixels and its breakpoints
// measured the viewport, while the docked panel actually renders inside
// .center, which the left and right docks eat into.
//
// PD-01: the Filer dock was unmounted outright whenever an SFTP/FTP tab was
// active (the dual-pane browser already shows files there), so switching tabs
// made the right dock disappear and the terminal area jump ~300px wider.
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames, wait } from "./browserHarness";
import App from "../App";
import { useStore } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import "../styles.css";
import { page, userEvent } from "vitest/browser";

afterEach(async () => {
  await browserAfterEach();
  disposeController("sidebar-drag-fixture");
  useStore.setState(initialState, true);
  vi.restoreAllMocks();
});

// The same IPC boundary scripts/check-review-ui.mjs and the review harness
// use: the real App, store and stylesheet over synthetic listings.
const seed = {
  profiles: [
    {
      id: "p-web",
      name: "web-prod-01",
      kind: "ssh" as const,
      host: "10.0.1.11",
      port: 22,
      username: "deploy",
      color: "#4fc1ff",
      groupId: null,
    },
    {
      id: "p-sftp",
      name: "backup@fileserver",
      kind: "sftp" as const,
      host: "fileserver.example.com",
      port: 22,
      username: "backup",
      color: "#a5d6a7",
      groupId: null,
    },
  ],
  groups: [],
  commands: [],
};
(window as unknown as { __seed: typeof seed }).__seed = seed;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
let serial = 5000;
const callbacks: Record<number, (message: unknown) => void> = {};
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (callback: (message: unknown) => void) => {
    const id = ++serial;
    callbacks[id] = callback;
    return id;
  },
  unregisterCallback: (id: number) => {
    delete callbacks[id];
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const S = (window as unknown as { __seed: typeof seed }).__seed;
    const entry = (name: string, p: string, isDir: boolean) => ({
      name,
      path: p,
      isDir,
      isSymlink: false,
      size: 10,
      modified: 1700000000,
      permissions: null,
      owner: null,
      group: null,
    });
    switch (cmd) {
      case "list_profiles":
        return S.profiles;
      case "list_session_groups":
        return S.groups;
      case "list_sender_commands":
        return S.commands;
      case "list_workspace_data":
        return {
          workspaces: [
            {
              id: "w1",
              name: "proj",
              root: "/srv/proj",
              server: {
                profileId: "p-web",
                name: "web-prod-01",
                host: "10.0.1.11",
                port: 22,
                username: "deploy",
              },
            },
          ],
        };
      case "sftp_home":
        return "/home/backup";
      case "local_home":
        return "C:/Users/dev";
      case "sftp_list":
      case "local_list": {
        const base = (args.path as string) || "/home/backup";
        return { path: base, entries: [entry("project", `${base}/project`, true)] };
      }
      case "list_system_fonts":
        return [];
      case "system_monospace_family":
        return null;
      case "portable_mode":
        return false;
      case "plugin:app|version":
        return "1.2.6";
      case "plugin:event|listen":
        return ++serial;
      case "plugin:event|unlisten":
        return undefined;
      case "show_main_window":
      case "finish_main_window":
      case "hide_main_window":
      case "set_startup_theme":
      case "resize_session":
      case "write_session":
      case "close_session":
      case "window_control":
        return undefined;
      default:
        if (cmd.startsWith("list_")) return [];
        return undefined;
    }
  },
};

const initialState = useStore.getState();

const fileSessionTab = () => {
  const profile = seed.profiles[1];
  const id = "sess-sftp";
  useStore.setState({
    ...initialState,
    language: "en",
    profiles: seed.profiles,
    tabs: [
      {
        info: {
          id,
          profileId: profile.id,
          name: profile.name,
          kind: "sftp" as const,
          protocol: "sftp",
          address: "fileserver.example.com:22",
          color: null,
          supportsRemoteFiles: true,
          recording: null,
          legacyAlgorithms: [],
          sharedConnection: false,
        },
        profile,
        number: 1,
        ordinal: 0,
        state: "connected" as const,
        commandActivity: "idle" as const,
        activityKind: "command" as const,
        cols: 80,
        rows: 24,
        paneId: initialState.activePaneId,
      },
    ],
    activeId: id,
    panes: [{ id: initialState.activePaneId, activeTabId: id }],
    panels: { sessions: true, filer: true, sender: true },
  });
};

const filerDock = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(".dock-slot")].find((dock) =>
    dock.querySelector(".panel-title.is-filer"),
  );

describe("layout regressions (Wave B)", () => {
  it("previews the sidebar boundary without repeatedly resizing a live terminal", async () => {
    await page.viewport(1200, 800);
    localStorage.clear();
    const id = "sidebar-drag-fixture";
    const profile = { id, name: id, kind: "local" as const };
    useStore.setState(
      {
        ...initialState,
        gpuRenderer: false,
        tabs: [
          {
            info: {
              id,
              profileId: null,
              name: id,
              kind: "local",
              protocol: "local",
              address: "",
              color: null,
              supportsRemoteFiles: false,
              recording: null,
              legacyAlgorithms: [],
              sharedConnection: false,
            },
            profile,
            number: 1,
            ordinal: 0,
            state: "connected",
            commandActivity: "idle",
            activityKind: "command",
            cols: 80,
            rows: 24,
            paneId: initialState.activePaneId,
          },
        ],
        activeId: id,
        panes: [{ id: initialState.activePaneId, activeTabId: id }],
        panels: { sessions: false, filer: true, sender: false },
        panelDocks: { left: [], right: ["filer"], bottom: [] },
      },
      true,
    );
    mount(h(App));
    await expect.poll(() => getController(id)).toBeDefined();
    const terminal = getController(id)!;
    await wait(200);
    await new Promise<void>((resolve) =>
      terminal.term.write("a line of scrollback\r\n".repeat(300), resolve),
    );
    await wait(200);
    const center = document.querySelector<HTMLElement>(".main > .center")!;
    const splitter = document.querySelector<HTMLElement>(".main > .splitter.is-vertical")!;
    const beforeWidth = center.getBoundingClientRect().width;
    const beforeCols = terminal.term.cols;
    const resizes: number[] = [];
    const subscription = terminal.term.onResize(({ cols }) => resizes.push(cols));
    const observations: { width: number; cols: number }[] = [];
    const at = pagePoint(splitter);
    await mouse.press(at.x, at.y);
    for (const delta of [20, 40, 60]) {
      await mouse.moveTo(at.x - delta, at.y);
      await wait(150); // Longer than the existing 100 ms fit settle interval.
      observations.push({ width: center.getBoundingClientRect().width, cols: terminal.term.cols });
    }
    const whileHeld = [...resizes];
    const transform = getComputedStyle(splitter, "::before").transform;
    await mouse.release(at.x - 60, at.y);
    await expect.poll(() => terminal.term.cols).toBeLessThan(beforeCols);
    for (const observation of observations) {
      expect(observation.width).toBeCloseTo(beforeWidth, 1);
      expect(observation.cols).toBe(beforeCols);
    }
    expect(whileHeld).toEqual([]);
    expect(transform).not.toBe("none");
    const previewDelta = new DOMMatrix(transform).m41;
    expect(previewDelta).toBeLessThan(0);
    expect(center.getBoundingClientRect().width).toBeCloseTo(beforeWidth + previewDelta, 0);
    expect(resizes).toHaveLength(1);
    subscription.dispose();
  });

  it.each(["left", "right"] as const)(
    "keeps the last preview on interruption and supports another %s dock adjustment",
    async (side) => {
      await page.viewport(1200, 800);
      localStorage.clear();
      useStore.setState(
        {
          ...initialState,
          tabs: [],
          activeId: null,
          panels: { sessions: false, filer: true, sender: false },
          panelDocks: {
            left: side === "left" ? ["filer"] : [],
            right: side === "right" ? ["filer"] : [],
            bottom: [],
          },
        },
        true,
      );
      mount(h(App));
      await twoFrames();
      const center = document.querySelector<HTMLElement>(".main > .center")!;
      const splitter = document.querySelector<HTMLElement>(".main > .splitter.is-vertical")!;
      const initialWidth = center.getBoundingClientRect().width;
      const at = pagePoint(splitter);
      const direction = side === "left" ? -1 : 1;
      await mouse.press(at.x, at.y);
      await mouse.moveTo(at.x + direction * 180, at.y);
      await twoFrames();
      const boundary = new DOMMatrix(getComputedStyle(splitter, "::before").transform).m41;
      await mouse.moveTo(at.x + direction * 40, at.y);
      await twoFrames();
      const preview = new DOMMatrix(getComputedStyle(splitter, "::before").transform).m41;
      expect(Math.abs(preview)).toBeLessThan(Math.abs(boundary));
      splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await twoFrames();
      expect(splitter.hasAttribute("data-preview")).toBe(false);
      expect(center.getBoundingClientRect().width).toBeCloseTo(
        initialWidth + (side === "left" ? -preview : preview),
        0,
      );
      await mouse.release(at.x + direction * 40, at.y);
      const afterCancel = center.getBoundingClientRect().width;
      splitter.focus();
      await userEvent.keyboard("{ArrowRight}");
      await twoFrames();
      expect(center.getBoundingClientRect().width).not.toBe(afterCancel);
    },
  );

  it("keeps a pointer preview when the opposite dock receives a keyboard resize", async () => {
    await page.viewport(1200, 800);
    localStorage.clear();
    useStore.setState(
      {
        ...initialState,
        tabs: [],
        activeId: null,
        panels: { sessions: true, filer: true, sender: false },
        panelDocks: { left: ["sessions"], right: ["filer"], bottom: [] },
      },
      true,
    );
    mount(h(App));
    await twoFrames();
    const main = document.querySelector<HTMLElement>(".main")!;
    const [left, right] = [...main.querySelectorAll<HTMLElement>(":scope > .splitter.is-vertical")];
    const rightBefore = parseFloat(main.style.getPropertyValue("--dock-right-w"));
    const at = pagePoint(right);
    await mouse.press(at.x, at.y);
    await mouse.moveTo(at.x - 40, at.y);
    await twoFrames();
    const preview = new DOMMatrix(getComputedStyle(right, "::before").transform).m41;
    left.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(right.hasAttribute("data-preview")).toBe(true);
    await mouse.release(at.x - 40, at.y);
    await twoFrames();
    expect(right.hasAttribute("data-preview")).toBe(false);
    expect(parseFloat(main.style.getPropertyValue("--dock-right-w"))).toBeCloseTo(
      rightBefore - preview,
      0,
    );
  });

  it("keeps the Filer dock mounted on a file session, with a reason (PD-01)", async () => {
    fileSessionTab();
    mount(h(App));
    await twoFrames();
    await new Promise((resolve) => setTimeout(resolve, 1800)); // lazy FtpPane + listings

    // The defect: the right dock was unmounted outright for SFTP/FTP tabs.
    const dock = filerDock(document);
    expect(dock, "the Filer dock is gone on a file session").toBeTruthy();
    // The panel explains itself instead of showing an empty browser.
    expect(dock!.textContent).toContain("dual-pane file manager");
    // The dual-pane workspace is the center area, as the notice says.
    expect(document.querySelector(".ftp-dual-pane")).not.toBeNull();
  });
});
