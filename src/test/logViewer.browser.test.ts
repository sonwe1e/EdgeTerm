import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LogWindow } from "../api";
import * as api from "../api";
import { LogViewerDialog, type LogViewerTarget } from "../components/LogViewerDialog";
import { FilerPanel } from "../components/panels/FilerPanel";
import { useStore, type Tab } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const size = 8 * 1024 * 1024 * 1024;
const newest: LogWindow = {
  path: "/logs/worker.log",
  start: size - 128,
  end: size,
  size,
  content: "boot ok\nlast result: ready\n",
  encoding: "UTF-8",
  modifiedAt: 1000,
};

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  sftpHome: vi.fn(async () => "/logs"),
  sftpList: vi.fn(async () => ({
    path: "/logs",
    entries: [
      {
        name: "worker.log",
        path: "/logs/worker.log",
        isDir: false,
        isSymlink: false,
        size,
        modified: 1,
        permissions: null,
        owner: null,
        group: null,
      },
    ],
  })),
  readLogWindow: vi.fn(async () => newest),
  remoteEditPath: vi.fn(),
  sftpDownload: vi.fn(),
  watchRemoteEdit: vi.fn(),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initial = useStore.getState();

function sshTab(id: string): Tab {
  return {
    info: {
      id,
      profileId: null,
      name: id,
      kind: "ssh",
      protocol: "ssh",
      address: "fixture",
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: initial.activePaneId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const tab = sshTab("ssh-A");
  useStore.setState(
    {
      ...initial,
      tabs: [tab],
      activeId: tab.info.id,
      panes: [{ id: initial.activePaneId, activeTabId: tab.info.id }],
    },
    true,
  );
  useStore.getState().setLanguage("en");
});
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
  vi.restoreAllMocks();
});

it("opens a remote log in Filer with no editable copy or SFTP download", async () => {
  await page.viewport(900, 560);
  mount(h("div", { style: { width: 440, height: 500, display: "flex" } }, h(FilerPanel)));
  await expect.poll(() => document.querySelectorAll(".filer-entry").length).toBe(1);
  await userEvent.click(page.getByText("worker.log", { exact: true }), { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "View large text (read-only)" }));
  await expect.poll(() => vi.mocked(api.readLogWindow).mock.calls.length).toBe(1);
  expect(api.readLogWindow).toHaveBeenCalledWith("ssh-A", "/logs/worker.log", null, true, null);
  await expect.element(page.getByText("last result: ready", { exact: false })).toBeVisible();
  await userEvent.fill(page.getByRole("searchbox", { name: "Find in loaded window" }), "last");
  expect(document.querySelector(".log-viewer-text mark")?.textContent).toBe("last");
  expect(api.remoteEditPath).not.toHaveBeenCalled();
  expect(api.sftpDownload).not.toHaveBeenCalled();
  expect(api.watchRemoteEdit).not.toHaveBeenCalled();
  const rect = document.querySelector(".log-viewer-dialog")!.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(560);
  await page.screenshot({ path: "../../artifacts/usability/log-viewer-900x560.png" });
  await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
  await expect.poll(() => document.querySelector(".log-viewer-dialog")).toBeNull();
});

it("discards a slow SSH response when the viewer switches servers", async () => {
  await page.viewport(1100, 720);
  let releaseA: ((value: LogWindow) => void) | undefined;
  vi.mocked(api.readLogWindow).mockImplementation((id) => {
    if (id === "ssh-A") {
      return new Promise<LogWindow>((resolve) => {
        releaseA = resolve;
      });
    }
    return Promise.resolve({ ...newest, content: "server B only" });
  });
  const target = (sessionId: string): LogViewerTarget => ({
    name: "worker.log",
    path: "/logs/worker.log",
    sourceTabId: sessionId,
    sessionId,
  });
  const mounted = mount(h(LogViewerDialog, { key: "A", target: target("ssh-A"), onClose() {} }));
  await expect.poll(() => vi.mocked(api.readLogWindow).mock.calls.length).toBe(1);
  mounted.render(h(LogViewerDialog, { key: "B", target: target("ssh-B"), onClose() {} }));
  await expect.element(page.getByText("server B only")).toBeVisible();
  releaseA?.({ ...newest, content: "STALE SECRET FROM A" });
  await twoFrames();
  expect(document.querySelector(".log-viewer-dialog")?.textContent).not.toContain(
    "STALE SECRET FROM A",
  );
});
