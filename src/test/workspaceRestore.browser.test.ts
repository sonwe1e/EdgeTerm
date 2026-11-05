import { createElement as h, StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import App from "../App";
import { pendingSessionInfo } from "../actions";
import { lastPaths, listingCache } from "../components/panels/filerDirectoryCache";
import { useStore } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import type { SessionProfile } from "../types";
import { WORKSPACE_STORAGE_KEY, type WorkspaceSnapshot } from "../workspaceSnapshot";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const initial = useStore.getState();
const ssh: SessionProfile = {
  id: "restore-ssh",
  name: "Build server",
  kind: "ssh",
  host: "fixture",
  username: "test",
  password: "in-memory-only",
};
const local: SessionProfile = {
  id: "restore-local",
  name: "PowerShell",
  kind: "local",
  shell: "pwsh.exe",
};
const opened: { sessionId: string; profile: SessionProfile }[] = [];
const listings: { command: string; path: string; id?: string }[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "list_profiles") return [ssh, local];
    if (command === "open_session") {
      const request = args as unknown as (typeof opened)[number];
      opened.push(request);
      return { status: "connected", info: pendingSessionInfo(request.sessionId, request.profile) };
    }
    if (command === "local_list" || command === "sftp_list") {
      const path = String(args.path);
      listings.push({ command, path, id: args.id as string });
      if (path.endsWith("/deleted")) throw new Error("directory removed");
      return { path, entries: [] };
    }
    if (command === "session_cwd") throw new Error("fixture uses explicit OSC directory reports");
    if (command === "local_home") return "G:/home";
    if (command === "sftp_home") return "/home/test";
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.1";
    if (command === "portable_mode") return false;
    return null;
  },
};

const snapshot = (): WorkspaceSnapshot => ({
  version: 1,
  tabs: [
    {
      id: "old-ssh-b",
      profile: ssh,
      number: 2,
      ordinal: 1,
      paneId: "left",
      directories: { terminal: "/srv/two", filer: "/data/two" },
    },
    {
      id: "old-ssh-a",
      profile: ssh,
      number: 1,
      ordinal: 0,
      paneId: "left",
      directories: { terminal: "/srv/one", filer: "/data/one" },
    },
    {
      id: "old-local",
      profile: local,
      number: 3,
      ordinal: 0,
      paneId: "right",
      directories: { terminal: "G:/work" },
    },
  ],
  panes: [
    { id: "left", activeTabId: "old-ssh-a" },
    { id: "right", activeTabId: "old-local" },
  ],
  layout: {
    kind: "split",
    direction: "row",
    children: [
      { kind: "leaf", paneId: "left" },
      { kind: "leaf", paneId: "right" },
    ],
    sizes: [0.6, 0.4],
  },
  activePaneId: "left",
  localFilerPath: "G:/downloads",
});
const app = () => h(StrictMode, null, h(App));
const reset = () => {
  for (const tab of useStore.getState().tabs) disposeController(tab.info.id);
  useStore.setState(
    {
      ...initial,
      language: "en",
      gpuRenderer: false,
      panels: { sessions: false, sender: false, filer: true },
    },
    true,
  );
  lastPaths.clear();
  listingCache.clear();
};

afterEach(async () => {
  await browserAfterEach();
  reset();
  localStorage.clear();
  opened.length = 0;
  listings.length = 0;
});

it("reopens the real App twice with ordered duplicate tabs, separate cwd and filer paths, and a closed tab removed", async () => {
  await page.viewport(1280, 800);
  reset();
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot()));
  const mounted = mount(app());
  await expect.poll(() => opened.length).toBe(3);
  await expect.poll(() => listings.some((item) => item.path === "/data/one")).toBe(true);
  expect(opened.map((item) => item.profile.cwd).sort()).toEqual(
    ["/srv/one", "/srv/two", "G:/work"].sort(),
  );
  expect(useStore.getState().tabs.map((tab) => tab.number)).toEqual([2, 1, 3]);
  const [first, active, localTab] = useStore.getState().tabs;
  expect(useStore.getState().activeId).toBe(active.info.id);
  await expect.poll(() => getController(active.info.id)?.term.element?.isConnected).toBe(true);
  const controller = getController(active.info.id)!;
  await new Promise<void>((done) =>
    controller.write(
      new TextEncoder().encode("\x1b]7;file://fixture/srv/new%20project\x1b\\"),
      done,
    ),
  );
  useStore.getState().revealInFiler(active.info.id, "/data/new files");
  await expect.poll(() => useStore.getState().tabs[1].directories?.filer).toBe("/data/new files");
  await useStore.getState().closeTab(first.info.id);
  useStore.getState().setActive(localTab.info.id);
  await expect.poll(() => listings.some((item) => item.path === "G:/downloads")).toBe(true);
  useStore.getState().setActive(active.info.id);
  await twoFrames();
  await page.screenshot({ path: "../../artifacts/usability/workspace-before-restart.png" });
  const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY)!;
  expect(saved).not.toContain("in-memory-only");
  mounted.render(null);
  reset();
  opened.length = 0;
  listings.length = 0;
  mounted.render(app());
  await expect.poll(() => opened.length).toBe(2);
  await expect.poll(() => listings.some((item) => item.path === "/data/new files")).toBe(true);
  expect(opened.find((item) => item.profile.kind === "ssh")?.profile.cwd).toBe("/srv/new project");
  expect(useStore.getState().tabs.map((tab) => tab.number)).toEqual([1, 3]);
  expect(
    useStore.getState().tabs.find((tab) => tab.info.id === useStore.getState().activeId)?.number,
  ).toBe(1);
  await twoFrames();
  await page.screenshot({ path: "../../artifacts/usability/workspace-after-restart.png" });
});

it("falls back to home when remembered local or remote directories were removed", async () => {
  reset();
  const value = snapshot();
  value.tabs[1].directories = { terminal: "/srv/one", filer: "/remote/deleted" };
  value.tabs[2].directories.terminal = "G:/deleted";
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(value));
  mount(app());
  await expect.poll(() => opened.length).toBe(3);
  await expect.poll(() => listings.some((item) => item.path === "/home/test")).toBe(true);
  expect(opened.find((item) => item.profile.kind === "local")?.profile.cwd).toBe("G:/home");
  expect(useStore.getState().tabs.find((tab) => tab.number === 1)?.directories?.filer).toBe(
    "/home/test",
  );
});
