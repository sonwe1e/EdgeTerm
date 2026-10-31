// Wave B — two layout defects from the 2026-10-20 review, both about surfaces
// assuming things about the window that are not true.
//
// UI-01: the workbench's three columns were fixed pixels and its breakpoints
// measured the viewport, while the workbench actually renders inside .center —
// which the left and right docks eat into. At 1440 with the default docks the
// editor got ~376px; at a laptop width it approached zero. The columns now
// compress and the breakpoints measure the container. This test mounts the
// workbench in a fixed-width wrapper so the container can be wider than the
// test viewport — the case the old viewport breakpoints got wrong.
//
// PD-01: the Filer dock was unmounted outright whenever an SFTP/FTP tab was
// active (the dual-pane browser already shows files there), so switching tabs
// made the right dock disappear and the terminal area jump ~300px wider.
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames, wait } from "./browserHarness";
import App from "../App";
import { useStore } from "../store";
import { Workbench } from "../workbench/Workbench";
import { useWorkbench } from "../workbench/store";
import { disposeController, getController } from "../terminalRegistry";
import "../styles.css";
import { page, userEvent } from "vitest/browser";

afterEach(async () => {
  await browserAfterEach();
  disposeController("sidebar-drag-fixture");
  useStore.setState(initialState, true);
  useWorkbench.setState(initialWorkbenchState, true);
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
          // The explorer column only exists beside an experiment; a project
          // without one is the state the onboarding warns about.
          experiments: [
            {
              id: "e1",
              workspaceId: "w1",
              name: "baseline",
              kind: "baseline",
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          runs: [],
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
const initialWorkbenchState = useWorkbench.getState();
const width = (element: Element) => Math.round(element.getBoundingClientRect().width);

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
    useWorkbench.getState().setView("terminals");
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
      useWorkbench.getState().setView("terminals");
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
    useWorkbench.getState().setView("terminals");
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

  it("keeps workbench controls and host chips within the dock-reduced width at both font sizes", async () => {
    await page.viewport(1440, 900);
    const mounted = mount(h(Workbench));
    mounted.container.classList.add("app");
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const language of ["en", "zh-CN"] as const) {
      useStore.setState({ language });
      for (const font of [12, 18]) {
        mounted.container.style.setProperty("--panel-font-size", `${font}px`);
        for (const available of [918, 578, 378, 260]) {
          mounted.container.style.width = `${available}px`;
          await twoFrames();
          const top = document.querySelector(".wb-top")!.getBoundingClientRect();
          for (const element of document.querySelectorAll<HTMLElement>(
            ".wb-top button, .wb-host-chip",
          )) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            expect(
              rect.left,
              `${language}/${font}/${available}: ${element.textContent} left`,
            ).toBeGreaterThanOrEqual(top.left);
            expect(
              rect.right,
              `${language}/${font}/${available}: ${element.textContent} right`,
            ).toBeLessThanOrEqual(top.right + 1);
            if (!element.closest(".wb-top")) continue;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
              if (!text.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              const label = range.getBoundingClientRect();
              expect(label.top).toBeGreaterThanOrEqual(rect.top - 1);
              expect(label.bottom).toBeLessThanOrEqual(rect.bottom + 1);
              expect(label.right).toBeLessThanOrEqual(rect.right + 1);
            }
          }
        }
      }
    }
    useStore.setState({ language: "en" });
  });

  it("keeps secondary actions reachable in a narrow workbench", async () => {
    useStore.setState({ language: "en" });
    const mounted = mount(h(Workbench));
    mounted.container.classList.add("app");
    mounted.container.style.width = "378px";
    await new Promise((resolve) => setTimeout(resolve, 400));
    await userEvent.click(document.querySelector(".wb-more")!);
    const menu = document.querySelector(".context-menu")!;
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    const newProject = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("New project"),
    )!;
    await userEvent.click(newProject);
    await twoFrames();
    expect(document.querySelector("dialog[open]")).not.toBeNull();
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

  it("measures the workbench's breakpoints against its container, not the viewport (UI-01)", async () => {
    // A 1000px container inside a viewport far narrower than that: the old
    // viewport breakpoints fired here and stacked the columns; the container
    // query must not, because 1000px still fits the narrowed three columns.
    const mounted = mount(h(Workbench));
    mounted.container.style.width = "1000px";
    mounted.container.style.height = "600px";
    await twoFrames();
    await new Promise((resolve) => setTimeout(resolve, 400)); // loadData + first paint

    const body = document.querySelector<HTMLElement>(".wb-body");
    expect(body, "workbench body missing").toBeTruthy();
    // The container is the query's subject; without it the media queries win.
    expect(getComputedStyle(body!).containerType).toBe("inline-size");

    const sidebar = document.querySelector<HTMLElement>(".wb-sidebar")!;
    const explorer = document.querySelector<HTMLElement>(".wb-explorer")!;
    const center = document.querySelector<HTMLElement>(".wb-center")!;
    const container = body!.clientWidth;

    // The narrowed branch (container > 900): the side columns give way to
    // 220px and the editor keeps its 360px floor.
    expect(width(sidebar)).toBeLessThanOrEqual(260);
    expect(width(explorer)).toBeLessThanOrEqual(280);
    expect(width(center)).toBeGreaterThanOrEqual(360);
    // And the columns still share the container rather than wrapping.
    expect(width(sidebar) + width(explorer) + width(center)).toBeLessThanOrEqual(container + 2);
  });
});
