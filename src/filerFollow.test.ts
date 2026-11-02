import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("./components/FileIcon", () => ({ FileIcon: () => null }));
vi.mock("./actions", () => ({ revealCwdInFiler: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("./nativeDialog", () => ({
  ask: vi.fn(async () => true),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  localHome: vi.fn(),
  localList: vi.fn(),
  localHostname: vi.fn(async () => "testbox"),
  localRemove: vi.fn(),
  sftpHome: vi.fn(),
  sftpList: vi.fn(),
  sftpRemove: vi.fn(),
  localRename: vi.fn(),
  sftpRename: vi.fn(),
  sessionCwd: vi.fn(),
  transferFiles: vi.fn(),
  startFileDrag: vi.fn(),
  dragStagingPath: vi.fn(),
  cancelTransfer: vi.fn(),
  onFileTransfer: vi.fn(async () => () => {}),
  onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []),
  listRecoverableTransfers: vi.fn(async () => []),
  controlFileTransfer: vi.fn(),
  onRemoteEditState: async () => () => {},
}));

import * as api from "./api";
import { revealCwdInFiler } from "./actions";
import { FilerPanel } from "./components/panels/FilerPanel";
import { lastPaths, listingCache } from "./components/panels/filerDirectoryCache";
import {
  FOLLOW_DEBOUNCE_MS,
  type FollowClock,
  createFollowQueue,
  followDestination,
  followMode,
  foreignHost,
  localShellPath,
  pauseFollowing,
  startFollowing,
  stopFollowing,
} from "./filerFollow";
import { useStore, type Tab } from "./store";
import { disposeController, setController } from "./terminalRegistry";
import type { TerminalController } from "./terminal";
import type { FileEntry } from "./types";

const initialState = useStore.getState();

/** A connected shell tab: the only kind the Filer can follow. */
const shellTab = (id: string, kind: "local" | "ssh"): Tab => ({
  info: {
    id,
    profileId: null,
    name: id,
    kind,
    protocol: kind === "ssh" ? "ssh" : "shell",
    address: kind === "ssh" ? id + ".example" : "default shell",
    color: "",
    supportsRemoteFiles: kind === "ssh",
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id, name: id, kind },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initialState.activePaneId,
});

const showFiler = (tabs: Tab[], activeId: string | null, filer = true) => {
  useStore.setState(
    {
      ...initialState,
      language: "en",
      tabs,
      activeId,
      panels: { ...initialState.panels, filer },
      panes: [{ id: initialState.activePaneId, activeTabId: activeId }],
      filerTarget: null,
      filerFollow: {},
      status: "",
    },
    true,
  );
};

/** Arranges a session already following, without going through the button. */
const follow = (sessionId: string) => {
  useStore.setState((state) => ({
    filerFollow: { ...state.filerFollow, [sessionId]: "following" },
  }));
};

/** The terminal's own latest report, the input the store action expects. */
const reportFromShell = (id: string, path: string, host = "testbox") => {
  setController(id, {
    reportedCwd: { host, path },
    dispose() {},
  } as unknown as TerminalController);
};

/** Advances the fake clock and lets the debounced flush's promise chain finish. */
const advanceReports = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** A clock the tests move by hand, so no debounce test waits on real time. */
const manualClock = () => {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: FollowClock = {
    setTimeout: (run, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delayMs, run });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(handle);
      timer.run();
    }
  };
  return { clock, advance };
};

const fileEntry = (dir: string, name: string, isDir = false): FileEntry => ({
  path: dir + "/" + name,
  name,
  isDir,
  isSymlink: false,
  size: 10,
  modified: 1,
  permissions: null,
  owner: null,
  group: null,
});

const entriesIn = (path: string): FileEntry[] => [
  fileEntry(path, "sub", true),
  fileEntry(path, "notes.txt"),
];

let host: HTMLDivElement;
let root: Root;

const fileRows = () => [...host.querySelectorAll<HTMLElement>(".filer-entry")];
const rowNamed = (name: string) =>
  fileRows().find((element) => element.querySelector(".row-label")?.textContent === name);
const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
/** Opens the panel's one menu unless it is already standing. */
const openFilerMenu = () => {
  if (document.querySelector(MENU_ITEM)) return;
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click());
};
/** A menu entry found by the label it starts with. */
const menuEntry = (matches: (label: string) => boolean) => {
  openFilerMenu();
  return [...document.querySelectorAll<HTMLButtonElement>(MENU_ITEM)].find((item) =>
    matches(item.textContent?.trim() ?? ""),
  )!;
};
/** The open folder, as the last crumb's own target: the bar is a trail now. */
const currentPath = () => {
  const crumbs = host.querySelectorAll<HTMLElement>(".filer-crumb[title]");
  return crumbs[crumbs.length - 1]?.getAttribute("title") ?? "";
};
/** Following is one of the panel menu's choices, beside "reveal". */
const followButton = () =>
  menuEntry((label) =>
    ["Follow terminal", "Following", "Paused"].some((name) => label.startsWith(name)),
  );
const pressed = () => followButton().getAttribute("aria-checked");
const mount = () => act(async () => root.render(h(FilerPanel)));
/** Lets the async listing a click started finish under act. */
const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

afterEach(() => {
  disposeController("alpha");
  disposeController("beta");
  vi.useRealTimers();
});

describe("the follow mode of a session", () => {
  it("starts off, per session", () => {
    expect(followMode({}, "alpha")).toBe("off");
    expect(followMode({ beta: "paused" }, "alpha")).toBe("off");
    expect(followMode({ beta: "paused" }, "beta")).toBe("paused");
  });

  it("turns on from off and from paused without touching other sessions", () => {
    const modes = { beta: "paused" } as const;
    expect(startFollowing(modes, "alpha")).toEqual({ beta: "paused", alpha: "following" });
    expect(startFollowing(modes, "beta")).toEqual({ beta: "following" });
  });

  it("keeps the record when the session is already following", () => {
    const modes = { alpha: "following" as const };
    expect(startFollowing(modes, "alpha")).toBe(modes);
  });

  it("pauses only a following session", () => {
    expect(pauseFollowing({ alpha: "following" }, "alpha")).toEqual({ alpha: "paused" });
    const off = {};
    expect(pauseFollowing(off, "alpha")).toBe(off);
    const paused = { alpha: "paused" as const };
    expect(pauseFollowing(paused, "alpha")).toBe(paused);
  });

  it("stops by dropping the session, leaving the others", () => {
    expect(stopFollowing({ alpha: "following", beta: "paused" }, "alpha")).toEqual({
      beta: "paused",
    });
    const modes = { beta: "paused" as const };
    expect(stopFollowing(modes, "alpha")).toBe(modes);
  });
});

describe("where a directory report leads", () => {
  it("takes an SSH session's own report, whatever host it names", () => {
    expect(
      followDestination(
        { host: "server-01", path: "/srv/app" },
        { local: false, hostname: "testbox", windows: true },
      ),
    ).toEqual({ kind: "path", path: "/srv/app" });
  });

  it("takes a local report from this machine and converts its drive path", () => {
    expect(
      followDestination(
        { host: "testbox.example.com", path: "/C:/Users/me" },
        { local: true, hostname: "testbox", windows: true },
      ),
    ).toEqual({ kind: "path", path: "C:\\Users\\me" });
  });

  it("refuses a local shell that moved to another machine", () => {
    expect(
      followDestination(
        { host: "server-01", path: "/home/me" },
        { local: true, hostname: "testbox", windows: false },
      ),
    ).toEqual({ kind: "foreign" });
  });

  it("refuses a host it cannot compare against rather than guess", () => {
    expect(foreignHost("server-01", "")).toBe(true);
    expect(foreignHost("", "")).toBe(false);
    expect(foreignHost("localhost", "testbox")).toBe(false);
    expect(foreignHost("testbox.lan", "TESTBOX")).toBe(false);
  });

  it("has nothing to follow before the shell reports", () => {
    expect(followDestination(null, { local: true, hostname: "testbox", windows: false })).toEqual({
      kind: "unreported",
    });
  });

  it("converts a Windows drive path only for Windows", () => {
    expect(localShellPath("/C:/Users/me", true)).toBe("C:\\Users\\me");
    expect(localShellPath("/C:/Users/me", false)).toBe("/C:/Users/me");
    expect(localShellPath("C:\\Users\\me", true)).toBe("C:\\Users\\me");
    expect(localShellPath("/home/me", true)).toBe("/home/me");
  });
});

describe("the report queue", () => {
  it("keeps the debounce inside the 300-500ms window the feature promises", () => {
    expect(FOLLOW_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
    expect(FOLLOW_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });

  it("flushes once, with the last report of a burst", () => {
    const flushed: [string, string][] = [];
    const { clock, advance } = manualClock();
    const queue = createFollowQueue(
      (sessionId, report) => flushed.push([sessionId, report.path]),
      clock,
      400,
    );
    queue.push("alpha", { host: "", path: "/one" });
    queue.push("alpha", { host: "", path: "/two" });
    queue.push("alpha", { host: "", path: "/three" });
    advance(399);
    expect(flushed).toEqual([]);
    advance(1);
    expect(flushed).toEqual([["alpha", "/three"]]);
  });

  it("drops a waiting report when it is cancelled", () => {
    const flushed: string[] = [];
    const { clock, advance } = manualClock();
    const queue = createFollowQueue((sessionId) => flushed.push(sessionId), clock, 400);
    queue.push("alpha", { host: "", path: "/one" });
    queue.cancel("alpha");
    advance(400);
    expect(flushed).toEqual([]);
  });

  it("keeps one timer per session", () => {
    const flushed: [string, string][] = [];
    const { clock, advance } = manualClock();
    const queue = createFollowQueue(
      (sessionId, report) => flushed.push([sessionId, report.path]),
      clock,
      400,
    );
    queue.push("alpha", { host: "", path: "/a" });
    advance(200);
    queue.push("beta", { host: "", path: "/b" });
    advance(200);
    expect(flushed).toEqual([["alpha", "/a"]]);
    advance(200);
    expect(flushed).toEqual([
      ["alpha", "/a"],
      ["beta", "/b"],
    ]);
  });
});

describe("following a shell's reports in the store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(api.sessionCwd).mockRejectedValue(new Error("no working directory"));
    showFiler([shellTab("alpha", "local"), shellTab("beta", "ssh")], "alpha");
  });

  it("moves the Filer to the last directory of a burst, once", async () => {
    follow("alpha");
    useStore.getState().terminalCwdReported("alpha", "/one");
    useStore.getState().terminalCwdReported("alpha", "/two");
    useStore.getState().terminalCwdReported("alpha", "/three");
    // The feature promises a debounce of 300-500ms; one listing for the burst.
    await advanceReports(299);
    expect(useStore.getState().filerTarget).toBeNull();
    await advanceReports(201);
    expect(useStore.getState().filerTarget).toEqual({
      sessionId: "alpha",
      path: "/three",
      token: 1,
    });
  });

  it("does nothing while following is off", async () => {
    useStore.getState().terminalCwdReported("alpha", "/one");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toBeNull();
  });

  it("does nothing while the Filer is closed", async () => {
    showFiler([shellTab("alpha", "local")], "alpha", false);
    follow("alpha");
    useStore.getState().terminalCwdReported("alpha", "/one");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toBeNull();
  });

  it("drops a waiting report when the Filer closes before it lands", async () => {
    follow("alpha");
    useStore.getState().terminalCwdReported("alpha", "/one");
    useStore.setState({ panels: { ...useStore.getState().panels, filer: false } });
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toBeNull();
  });

  it("follows only the session the Filer is showing", async () => {
    useStore.setState({ activeId: "beta" });
    follow("alpha");
    follow("beta");
    useStore.getState().terminalCwdReported("alpha", "/a");
    useStore.getState().terminalCwdReported("beta", "/b");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toEqual({
      sessionId: "beta",
      path: "/b",
      token: 1,
    });
  });

  it("keeps later reports out after a manual navigation paused the follow", async () => {
    follow("alpha");
    useStore.getState().pauseFilerFollow("alpha");
    expect(useStore.getState().status).toBe("Follow paused: you browsed away manually");
    useStore.getState().terminalCwdReported("alpha", "/one");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toBeNull();
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("paused");
  });

  it("drops a report already waiting when the user pauses", async () => {
    follow("alpha");
    useStore.getState().terminalCwdReported("alpha", "/one");
    useStore.getState().pauseFilerFollow("alpha");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toBeNull();
  });

  it("pauses a local follow that reached another host, and says why", async () => {
    follow("alpha");
    useStore.getState().terminalCwdReported("alpha", "/home/me", "server-01");
    await advanceReports(500);
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("paused");
    expect(useStore.getState().status).toBe(
      "The shell moved to another host or container; following paused",
    );
    expect(useStore.getState().filerTarget).toBeNull();
  });

  it("takes the report of an SSH session from the server it browses", async () => {
    useStore.setState({ activeId: "beta" });
    follow("beta");
    useStore.getState().terminalCwdReported("beta", "/srv/app", "server-01");
    await advanceReports(500);
    expect(useStore.getState().filerTarget).toEqual({
      sessionId: "beta",
      path: "/srv/app",
      token: 1,
    });
  });
});

describe("turning following on in the store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(api.sessionCwd).mockRejectedValue(new Error("no working directory"));
    showFiler([shellTab("alpha", "local")], "alpha");
  });

  it("shows the directory the shell reported and says when resuming", async () => {
    useStore.setState({ filerFollow: { alpha: "paused" } });
    reportFromShell("alpha", "/work");
    useStore.getState().startFilerFollow("alpha");
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("following");
    await vi.waitFor(() =>
      expect(useStore.getState().filerTarget).toEqual({
        sessionId: "alpha",
        path: "/work",
        token: 1,
      }),
    );
    expect(useStore.getState().status).toBe("Following again: /work");
  });

  it("asks the backend once when the shell never reported a directory", async () => {
    vi.mocked(api.sessionCwd).mockResolvedValue("/from-backend");
    useStore.getState().startFilerFollow("alpha");
    await vi.waitFor(() =>
      expect(useStore.getState().filerTarget).toEqual({
        sessionId: "alpha",
        path: "/from-backend",
        token: 1,
      }),
    );
    expect(api.sessionCwd).toHaveBeenCalledTimes(1);
    expect(useStore.getState().status).toBe(
      "Synced to the shell's directory; this shell reports no directory changes, so later cd commands will not follow",
    );
  });

  it("says following is unavailable when neither a report nor the backend answers", async () => {
    useStore.getState().startFilerFollow("alpha");
    await vi.waitFor(() =>
      expect(useStore.getState().status).toBe(
        "This shell reports no working directory, so it cannot be followed",
      ),
    );
    expect(useStore.getState().filerTarget).toBeNull();
    // The mode stays on: a report that arrives later is followed from there.
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("following");
  });

  it("stops following and forgets the session", () => {
    follow("alpha");
    useStore.getState().stopFilerFollow("alpha");
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("off");
  });

  it("resolves the followed session's directory only while the panel shows it", async () => {
    follow("alpha");
    reportFromShell("alpha", "/work");
    expect(await useStore.getState().resolveFilerFollow("alpha")).toBe("/work");
    useStore.setState({ panels: { ...useStore.getState().panels, filer: false } });
    expect(await useStore.getState().resolveFilerFollow("alpha")).toBeNull();
    useStore.getState().stopFilerFollow("alpha");
    expect(await useStore.getState().resolveFilerFollow("alpha")).toBeNull();
  });
});

describe("the Filer's follow button and manual browsing", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.mocked(api.localHome).mockResolvedValue("/home/me");
    vi.mocked(api.localList).mockImplementation(async (path: string) => ({
      path,
      entries: entriesIn(path),
    }));
    vi.mocked(api.sessionCwd).mockRejectedValue(new Error("no working directory"));
    // The panel keeps the last directory per source in module scope; a test
    // that navigates must not leave its path behind for the next one.
    lastPaths.clear();
    listingCache.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("arms and stops the follow from the directory bar", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    await mount();
    await settle();
    expect(pressed()).toBe("false");
    expect(followButton().textContent?.trim()).toBe("Follow terminal");

    followButton().click();
    await settle();
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("following");
    expect(pressed()).toBe("true");
    expect(followButton().textContent?.trim()).toBe("Following");

    followButton().click();
    await settle();
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("off");
    expect(pressed()).toBe("false");
  });

  it("navigates to the shell's directory when the follow is turned on", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    reportFromShell("alpha", "/work");
    await mount();
    await settle();
    expect(currentPath()).toBe("/home/me");

    followButton().click();
    await settle();
    expect(api.localList).toHaveBeenCalledWith("/work");
    expect(currentPath()).toBe("/work");
  });

  it("opens a followed session at the shell's directory, not the last browsed one", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    reportFromShell("alpha", "/work");
    follow("alpha");
    await mount();
    await settle();
    expect(api.localHome).not.toHaveBeenCalled();
    expect(api.localList).toHaveBeenCalledWith("/work");
    expect(currentPath()).toBe("/work");
  });

  it("pauses when a folder is opened by hand", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    reportFromShell("alpha", "/work");
    follow("alpha");
    await mount();
    await settle();
    expect(currentPath()).toBe("/work");

    await act(async () => {
      rowNamed("sub")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settle();
    expect(currentPath()).toBe("/work/sub");
    expect(followMode(useStore.getState().filerFollow, "alpha")).toBe("paused");
    expect(useStore.getState().status).toBe("Follow paused: you browsed away manually");
    expect(followButton().textContent?.trim()).toBe("Paused");
  });

  it("resumes from paused at the shell's latest directory", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    reportFromShell("alpha", "/work");
    useStore.setState({ filerFollow: { alpha: "paused" } });
    await mount();
    await settle();
    expect(currentPath()).toBe("/home/me");
    expect(followButton().textContent?.trim()).toBe("Paused");

    followButton().click();
    await settle();
    expect(currentPath()).toBe("/work");
    expect(useStore.getState().status).toBe("Following again: /work");
  });

  it("keeps the locate button asking the terminal for its directory", async () => {
    showFiler([shellTab("alpha", "local")], "alpha");
    await mount();
    await settle();
    const locate = menuEntry((label) => label.startsWith("Terminal folder"));
    locate.click();
    expect(revealCwdInFiler).toHaveBeenCalledWith("alpha");
  });
});
