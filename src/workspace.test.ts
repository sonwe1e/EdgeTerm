import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf } from "./layout";
import { useStore } from "./store";
import type { SessionProfile } from "./types";
import {
  parseWorkspace,
  snapshotWorkspace,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceSnapshot,
} from "./workspaceSnapshot";

vi.mock("./api", () => ({
  closeSession: vi.fn().mockResolvedValue(undefined),
  stopRemoteEdits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./actions", async (original) => {
  const actions = await original<typeof import("./actions")>();
  return {
    ...actions,
    connectSession: vi.fn().mockResolvedValue(null),
    ensureController: vi.fn().mockResolvedValue(undefined),
    shellCwd: vi.fn().mockRejectedValue(new Error("no report")),
  };
});
import { connectSession, shellCwd } from "./actions";
import {
  captureWorkspaceDirectories,
  flushWorkspace,
  restoreWorkspace,
  startWorkspace,
} from "./workspace";
import { rememberWorkspaceDirectory } from "./workspaceDirectories";

const initial = useStore.getState();
const cleanups: (() => void)[] = [];
const profile: SessionProfile = {
  id: "server",
  name: "SSH",
  kind: "ssh",
  host: "server",
  username: "alice",
  password: "secret",
  passphrase: "key-secret",
};

function fixture(): WorkspaceSnapshot {
  return {
    version: 1,
    tabs: [
      {
        id: "old-b",
        profile,
        number: 2,
        ordinal: 1,
        paneId: "left",
        directories: { terminal: "/srv/two", filer: "/data/files" },
      },
      {
        id: "old-a",
        profile,
        number: 1,
        ordinal: 0,
        paneId: "left",
        directories: { terminal: "/srv/one", filer: "/home/alice" },
      },
      {
        id: "old-c",
        profile: { id: "", name: "local", kind: "local", shell: "pwsh.exe" },
        number: 3,
        ordinal: 0,
        paneId: "right",
        directories: { terminal: "G:\\work", local: "G:\\files" },
      },
    ],
    panes: [
      { id: "left", activeTabId: "old-a" },
      { id: "right", activeTabId: "old-c" },
    ],
    layout: {
      kind: "split",
      direction: "row",
      children: [leaf("left"), leaf("right")],
      sizes: [0.6, 0.4],
    },
    activePaneId: "left",
    localFilerPath: "G:\\shared files",
  };
}
const stored = () => parseWorkspace(localStorage.getItem(WORKSPACE_STORAGE_KEY))!;
const start = () => {
  const stop = startWorkspace(Promise.resolve());
  cleanups.push(stop);
  return stop;
};

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ ...initial, loadProfiles: vi.fn().mockResolvedValue(true) });
  vi.mocked(connectSession).mockClear();
  vi.mocked(shellCwd).mockReset().mockRejectedValue(new Error("unavailable"));
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  useStore.setState(initial);
  vi.useRealTimers();
});

describe("workspace persistence", () => {
  it("restores duplicates, tab order, pane selection, numbers and separate directories with fresh IDs", () => {
    useStore.setState({ profiles: [{ ...profile, password: "new-secret", host: "edited-host" }] });
    const tabs = restoreWorkspace(parseWorkspace(JSON.stringify(fixture()))!);
    expect(tabs.map((tab) => tab.number)).toEqual([2, 1, 3]);
    expect(tabs.map((tab) => tab.ordinal)).toEqual([1, 0, 0]);
    expect(
      tabs.every((tab) => !tab.info.id.startsWith("old-") && tab.commandActivity === "idle"),
    ).toBe(true);
    expect(tabs[0].profile.password).toBe("new-secret");
    expect(tabs[0].profile.host).toBe("edited-host");
    expect(tabs[0].directories).toEqual({ terminal: "/srv/two", filer: "/data/files" });
    expect(useStore.getState().activeId).toBe(tabs[1].info.id);
    expect(useStore.getState().panes[1].activeTabId).toBe(tabs[2].info.id);
    expect(useStore.getState().layout).toMatchObject({ sizes: [0.6, 0.4] });
    const saved = JSON.stringify(snapshotWorkspace(useStore.getState()));
    expect(saved).not.toContain("secret");
    expect(saved).not.toContain("password");
    expect(saved).not.toContain("passphrase");
  });

  it("ignores corrupted storage and repairs missing layout and duplicate tab numbers", () => {
    for (const raw of [null, "{", "null", '{"version":999,"tabs":[]}', "x".repeat(2_000_001)])
      expect(parseWorkspace(raw)).toBeNull();
    const value = fixture();
    value.tabs[0].number = 1;
    value.tabs[0].profile = { ...profile, password: "do-not-load" };
    value.tabs[0].directories.terminal = "/tmp/\ncommand";
    value.layout = leaf("nonexistent");
    const parsed = parseWorkspace(JSON.stringify(value))!;
    expect(new Set(parsed.tabs.map((tab) => tab.number)).size).toBe(3);
    expect(parsed.tabs[0].directories.terminal).toBeUndefined();
    expect(parsed.tabs[0].profile.password).toBeUndefined();
    expect(parsed.panes).toHaveLength(1);
    expect(parsed.tabs.every((tab) => tab.paneId === parsed.panes[0].id)).toBe(true);
  });

  it("survives the StrictMode setup/cleanup cycle without erasing the snapshot or connecting twice", async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture()));
    start()();
    expect(stored().tabs).toHaveLength(3);
    start();
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledTimes(3));
    expect(stored().tabs.map((tab) => tab.number)).toEqual([2, 1, 3]);
  });

  it("keeps the saved workspace when profiles cannot load", async () => {
    const raw = JSON.stringify(fixture());
    localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    const load = vi.fn().mockResolvedValue(false);
    useStore.setState({ loadProfiles: load });
    const stop = start();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    stop();
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("saves explicit tab closes and restores the remaining tab after a second launch", async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture()));
    const stop = start();
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledTimes(3));
    const [first, second, third] = useStore.getState().tabs;
    rememberWorkspaceDirectory(second.info.id, "terminal", "/new/cwd");
    await useStore.getState().closeTab(first.info.id);
    await useStore.getState().closeTab(third.info.id);
    expect(stored().tabs).toHaveLength(1);
    stop();
    useStore.setState({ ...initial, loadProfiles: vi.fn().mockResolvedValue(true) });
    start();
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledTimes(4));
    expect(useStore.getState().tabs[0].directories?.terminal).toBe("/new/cwd");
    expect(useStore.getState().tabs[0].info.id).not.toBe(second.info.id);
  });

  it("does not replace a workspace the user changed while profiles were loading", async () => {
    let loaded!: (value: boolean) => void;
    useStore.setState({
      loadProfiles: () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    });
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fixture()));
    start();
    await vi.waitFor(() => expect(loaded).toBeTypeOf("function"));
    useStore.setState({ tabs: [] });
    loaded(true);
    await vi.waitFor(() => expect(stored().tabs).toHaveLength(0));
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("updates real cwd independently and ignores failed or stale queries", async () => {
    const [a, b] = restoreWorkspace(fixture());
    useStore.getState().applyState(a.info.id, "connected");
    useStore.getState().applyState(b.info.id, "connected");
    vi.mocked(shellCwd).mockImplementation(async (tab) => {
      if (tab.info.id === a.info.id) return "/actual/cwd";
      throw new Error("offline");
    });
    await captureWorkspaceDirectories();
    expect(useStore.getState().tabs[0].directories).toEqual({
      terminal: "/actual/cwd",
      filer: "/data/files",
    });
    expect(useStore.getState().tabs[1].directories?.terminal).toBe("/srv/one");
    let reply!: (path: string) => void;
    vi.mocked(shellCwd).mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    useStore.getState().applyState(b.info.id, "closed");
    const outdated = captureWorkspaceDirectories();
    rememberWorkspaceDirectory(a.info.id, "terminal", "/newer-shell-report");
    reply("/older-query");
    await outdated;
    expect(useStore.getState().tabs[0].directories?.terminal).toBe("/newer-shell-report");
    const capturing = captureWorkspaceDirectories();
    await useStore.getState().closeTab(a.info.id);
    reply("/stale/path");
    await capturing;
    expect(
      useStore.getState().tabs.some((tab) => tab.directories?.terminal === "/stale/path"),
    ).toBe(false);
  });

  it("bounds exit-time directory capture when a server is unresponsive", async () => {
    const [tab] = restoreWorkspace(fixture());
    useStore.getState().applyState(tab.info.id, "connected");
    let finish!: (value: string) => void;
    vi.mocked(shellCwd).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    const flushed = flushWorkspace();
    await vi.advanceTimersByTimeAsync(1800);
    await flushed;
    finish("/late");
    await captureWorkspaceDirectories();
  });
});
