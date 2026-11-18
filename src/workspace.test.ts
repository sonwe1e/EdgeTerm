import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf } from "./layout";
import { useStore } from "./store";
import type { SessionProfile } from "./types";
import {
  parseWorkspace,
  readSavedWorkspace,
  snapshotWorkspace,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_UNREADABLE_KEY,
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

describe("reading the saved workspace", () => {
  const storage = (raw: string | null) => ({ getItem: () => raw });

  it("treats an empty slot as a fresh install, not a failure", () => {
    expect(readSavedWorkspace(storage(null))).toEqual({ snapshot: null, unreadable: false });
  });

  it("reports a saved workspace that cannot be read", () => {
    expect(readSavedWorkspace(storage("{ not json"))).toEqual({ snapshot: null, unreadable: true });
    // Valid JSON that is not a snapshot is the same state to the user: the
    // sessions are gone, not absent.
    expect(readSavedWorkspace(storage("[]"))).toEqual({ snapshot: null, unreadable: true });
  });

  it("treats storage that refuses to answer as nothing saved", () => {
    const blocked = {
      getItem: () => {
        throw new Error("storage blocked");
      },
    };
    expect(readSavedWorkspace(blocked)).toEqual({ snapshot: null, unreadable: false });
  });
});

it("keeps the bytes of a snapshot it could not read", async () => {
  const damaged = '{"version":1,"tabs":[';
  localStorage.setItem(WORKSPACE_STORAGE_KEY, damaged);
  const load = vi.fn().mockResolvedValue(true);
  useStore.setState({ loadProfiles: load });
  const stop = start();
  await vi.waitFor(() => expect(localStorage.getItem(WORKSPACE_UNREADABLE_KEY)).toBe(damaged));
  stop();

  // The first save replaces the stored snapshot; the unreadable one has to
  // survive somewhere, or the only copy of what the user had open is gone.
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBe(damaged);
});

it("says that tabs will not be saved when the sessions cannot be loaded", async () => {
  const raw = JSON.stringify(fixture());
  localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
  const load = vi.fn().mockResolvedValue(false);
  useStore.setState({ loadProfiles: load });
  const stop = start();
  await vi.waitFor(() => expect(useStore.getState().status).toContain("will not be saved"));
  stop();
  // The old snapshot survives untouched — the point of not writing.
  expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(raw);
});

it("keeps the surviving split when a pane lost all of its tabs", () => {
  // Tabs are cut at the limit, so a saved workspace can come back with a pane
  // that lost every tab in it. Dropping that pane is right; collapsing the two
  // remaining splits into one pane throws away sizes the user set by hand.
  const value = structuredClone(fixture());
  value.layout = {
    kind: "split",
    direction: "row",
    children: [
      { kind: "leaf", paneId: "left" },
      { kind: "leaf", paneId: "right" },
      { kind: "leaf", paneId: "gone" },
    ],
    sizes: [0.5, 0.25, 0.25],
  };

  const parsed = parseWorkspace(JSON.stringify(value))!;
  expect(parsed.panes.map((pane) => pane.id)).toEqual(["left", "right"]);
  expect(parsed.layout.kind).toBe("split");
  const layout = parsed.layout as { sizes: number[] };
  expect(layout.sizes).toHaveLength(2);
  expect(layout.sizes[0]).toBeCloseTo(0.5 / 0.75);
  expect(layout.sizes[1]).toBeCloseTo(0.25 / 0.75);
});

it("says once when the layout cannot be written", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  const load = vi.fn().mockResolvedValue(true);
  useStore.setState({ loadProfiles: load });
  const stop = start();
  await vi.waitFor(() => expect(useStore.getState().status).toContain("could not be saved"));
  expect(useStore.getState().status).toContain("quota exceeded");
  stop();
  setItem.mockRestore();
});
