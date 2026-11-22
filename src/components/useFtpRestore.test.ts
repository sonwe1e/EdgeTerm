import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useStore, type Tab } from "../store";
import { useFtpDirectory } from "./useFtpDirectory";

vi.mock("../api", () => ({
  sftpHome: vi.fn(),
  localHome: vi.fn(),
  sftpList: vi.fn(),
  localList: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const sessionId = "ftp-restore-test";
const paths = { filer: "/server-saved", local: "/machine-saved" };
const tab = { state: "connected", info: { id: sessionId }, directories: paths } as Tab;
const listing = (path: string) => ({ path, entries: [] });

describe.each(["remote", "local"] as const)("%s FTP pane startup", (side) => {
  const remote = side === "remote";
  const saved = remote ? paths.filer : paths.local;
  const home = remote ? "/server-home" : "/machine-home";
  const next = remote ? "/server-next" : "/machine-next";
  const read = vi.mocked(remote ? api.sftpList : api.localList);
  const readHome = vi.mocked(remote ? api.sftpHome : api.localHome);
  const listedPaths = () => read.mock.calls.map((args) => args[remote ? 1 : 0]);
  let root: ReturnType<typeof createRoot>;
  let directory: ReturnType<typeof useFtpDirectory>;
  let oldTabs: Tab[];
  const panePath = () => (remote ? directory.remotePath : directory.localPath);
  const paneHome = () => (remote ? directory.remoteHome : directory.localHome);
  const paneError = () => (remote ? directory.remoteError : directory.localError);
  const otherError = () => (remote ? directory.localError : directory.remoteError);
  const otherPath = () => (remote ? directory.localPath : directory.remotePath);
  const storedPath = () => useStore.getState().tabs[0].directories?.[remote ? "filer" : "local"];
  const navigate = () => (remote ? directory.loadRemote(next) : directory.loadLocal(next));
  async function mount() {
    function Harness() {
      directory = useFtpDirectory({ tab, sessionId });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
  }

  beforeEach(() => {
    oldTabs = useStore.getState().tabs;
    useStore.setState({ tabs: [tab] });
    vi.resetAllMocks();
    vi.mocked(api.sftpHome).mockResolvedValue("/server-home");
    vi.mocked(api.localHome).mockResolvedValue("/machine-home");
    vi.mocked(api.sftpList).mockImplementation(async (_, path) => listing(path));
    vi.mocked(api.localList).mockImplementation(async (path) => listing(path));
    react.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    react.IS_REACT_ACT_ENVIRONMENT = false;
    useStore.setState({ tabs: oldTabs });
  });

  it("restores the saved directory normally", async () => {
    await mount();
    expect(listedPaths()).toEqual([saved]);
    expect([panePath(), paneError(), storedPath()]).toEqual([saved, null, saved]);
  });

  it("falls back to Home only on a current saved-directory read failure", async () => {
    read.mockRejectedValueOnce(new Error("saved directory disappeared"));
    await mount();
    expect(listedPaths()).toEqual([saved, home]);
    expect([panePath(), paneError(), storedPath()]).toEqual([home, null, home]);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    "keeps newer navigation (startup resolves=%s, startup settles first=%s)",
    async (ok, first) => {
      const startup = deferred<ReturnType<typeof listing>>();
      const manual = deferred<ReturnType<typeof listing>>();
      read.mockReturnValueOnce(startup.promise).mockReturnValueOnce(manual.promise);
      await mount();
      let navigating: Promise<boolean> | undefined;
      await act(async () => {
        navigating = navigate();
      });
      const settleStartup = () => {
        if (ok) startup.resolve(listing(saved));
        else startup.reject(new Error("stale startup read failed"));
      };
      if (first) {
        await act(async () => settleStartup());
        expect(listedPaths()).toEqual([saved, next]);
      }
      await act(async () => {
        manual.resolve(listing(next));
        await navigating;
      });
      if (!first) await act(async () => settleStartup());
      expect(listedPaths()).toEqual([saved, next]);
      expect([panePath(), paneError(), storedPath()]).toEqual([next, null, next]);
    },
  );

  it.each([true, false])(
    "does not start a restore after Home lookup (manual settles first=%s)",
    async (first) => {
      const lookup = deferred<string>();
      const manual = deferred<ReturnType<typeof listing>>();
      readHome.mockReturnValueOnce(lookup.promise);
      await mount();
      read.mockReturnValueOnce(manual.promise);
      let navigating: Promise<boolean> | undefined;
      await act(async () => {
        navigating = navigate();
      });
      async function finishNavigation() {
        await act(async () => {
          manual.resolve(listing(next));
          await navigating;
        });
      }
      if (first) await finishNavigation();
      await act(async () => lookup.resolve(home));
      if (!first) await finishNavigation();
      expect(listedPaths()).toEqual([next]);
      expect([panePath(), paneHome(), storedPath()]).toEqual([next, home, next]);
      expect(otherPath()).toBe(remote ? paths.local : paths.filer);
    },
  );

  it("reports a Home lookup failure on the pane that failed", async () => {
    readHome.mockRejectedValueOnce(new Error("could not discover Home"));
    await mount();
    expect([paneError(), otherError()]).toEqual(["could not discover Home", null]);
  });

  it("still restores the other pane when this pane's Home lookup fails", async () => {
    readHome.mockRejectedValueOnce(new Error("could not discover Home"));
    await mount();
    expect([panePath(), otherPath()]).toEqual(["", remote ? paths.local : paths.filer]);
  });

  it("does not report a stale Home lookup error after manual navigation", async () => {
    const lookup = deferred<string>();
    readHome.mockReturnValueOnce(lookup.promise);
    await mount();
    await act(async () => {
      await (remote ? directory.loadRemote("/manual") : directory.loadLocal("/manual"));
    });
    await act(async () => lookup.reject(new Error("could not discover Home")));
    expect([panePath(), paneError(), otherError()]).toEqual(["/manual", null, null]);
  });
});
