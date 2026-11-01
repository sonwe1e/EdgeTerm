import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortForward, PortForwardSpec } from "./api";
import { classifyTerminalUrl, createRemotePreview, type RemotePreviewDeps } from "./remotePreview";
import type { SessionKind } from "./types";

// The production wiring in terminalShared uses these wrappers; mocking them
// lets the Ctrl+click tests drive the real preview code with fake IPC.
const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  startPortForward: vi.fn(),
  listPortForwards: vi.fn(),
  stopPortForward: vi.fn(),
  removePortForward: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("./api", () => ({
  startPortForward: mocks.startPortForward,
  listPortForwards: mocks.listPortForwards,
  stopPortForward: mocks.stopPortForward,
  removePortForward: mocks.removePortForward,
}));

import { openTerminalWebLink } from "./terminalShared";

const spec = (listenPort: number, targetPort = 6006): PortForwardSpec => ({
  direction: "local",
  listenHost: "127.0.0.1",
  listenPort,
  targetHost: "127.0.0.1",
  targetPort,
});

const row = (overrides: Partial<PortForward> = {}): PortForward => ({
  id: "tunnel",
  owner: "session",
  address: "ssh://example.test",
  spec: spec(41000),
  status: "listening",
  error: null,
  connections: 0,
  sentBytes: 0,
  receivedBytes: 0,
  ...overrides,
});

function makeDeps() {
  return {
    startForward: vi.fn(
      async (_owner: string, _spec: PortForwardSpec): Promise<PortForward> =>
        row({ status: "starting", spec: spec(0) }),
    ),
    listForwards: vi.fn(async (): Promise<PortForward[]> => []),
    stopForward: vi.fn(async (_id: string): Promise<void> => {}),
    removeForward: vi.fn(async (_id: string): Promise<void> => {}),
    openUrl: vi.fn(async (_url: string): Promise<void> => {}),
    sleep: vi.fn(async (_ms: number): Promise<void> => {}),
  };
}

type Deps = ReturnType<typeof makeDeps>;

const previewOf = (deps: Deps) => createRemotePreview(deps as RemotePreviewDeps);

const forwarded = {
  kind: "forward" as const,
  targetHost: "127.0.0.1",
  targetPort: 6006,
  suffixPath: "/",
};

const direct = { kind: "direct" as const, targetHost: "", targetPort: 0, suffixPath: "" };

const FORWARDED_LINKS: {
  url: string;
  targetHost: string;
  targetPort: number;
  suffixPath: string;
}[] = [
  {
    url: "http://localhost:6006/",
    targetHost: "127.0.0.1",
    targetPort: 6006,
    suffixPath: "/",
  },
  {
    url: "http://127.0.0.1:8080/app?tab=1#readme",
    targetHost: "127.0.0.1",
    targetPort: 8080,
    suffixPath: "/app?tab=1#readme",
  },
  // A wildcard listener is reached over the loopback of the same family, the
  // way the Tunnels list's "Use" action fills the target in.
  {
    url: "http://0.0.0.0:3000/console",
    targetHost: "127.0.0.1",
    targetPort: 3000,
    suffixPath: "/console",
  },
  {
    url: "https://[::1]:8443/login?next=/",
    targetHost: "::1",
    targetPort: 8443,
    suffixPath: "/login?next=/",
  },
  {
    url: "http://[::]:5000/",
    targetHost: "::1",
    targetPort: 5000,
    suffixPath: "/",
  },
  // The scheme is kept: the remote program decides whether it speaks TLS, and
  // a certificate warning is the browser's to show.
  {
    url: "https://LOCALHOST:9443/preview",
    targetHost: "127.0.0.1",
    targetPort: 9443,
    suffixPath: "/preview",
  },
  // URL drops the default port; dialling it again keeps the link meaningful.
  {
    url: "http://localhost/",
    targetHost: "127.0.0.1",
    targetPort: 80,
    suffixPath: "/",
  },
  {
    url: "https://localhost/",
    targetHost: "127.0.0.1",
    targetPort: 443,
    suffixPath: "/",
  },
  {
    url: "http://localhost.:6006/",
    targetHost: "127.0.0.1",
    targetPort: 6006,
    suffixPath: "/",
  },
];

const DIRECT_LINKS: { kind: SessionKind; url: string }[] = [
  // Public addresses belong to the browser, whatever opened them.
  { kind: "ssh", url: "http://example.com:6006/" },
  { kind: "ssh", url: "https://docs.example.com/guide" },
  { kind: "ssh", url: "http://localhost.example.com:6006/" },
  // Only web links are previews.
  { kind: "ssh", url: "ftp://localhost:21/files" },
  { kind: "ssh", url: "mailto:dev@example.com" },
  { kind: "ssh", url: "not a url" },
  // No SSH transport: this machine's loopback is already the right one.
  { kind: "local", url: "http://localhost:6006/" },
  { kind: "serial", url: "http://localhost:6006/" },
  { kind: "telnet", url: "http://localhost:6006/" },
  { kind: "sftp", url: "http://localhost:6006/" },
  { kind: "ftp", url: "http://localhost:6006/" },
];

describe("classifyTerminalUrl", () => {
  it.each(FORWARDED_LINKS)(
    "forwards $url to $targetHost:$targetPort for an SSH session",
    ({ url, targetHost, targetPort, suffixPath }) => {
      expect(classifyTerminalUrl("ssh", url)).toEqual({
        kind: "forward",
        targetHost,
        targetPort,
        suffixPath,
      });
    },
  );

  it.each(DIRECT_LINKS)("opens $url as written from a $kind session", ({ kind, url }) => {
    expect(classifyTerminalUrl(kind, url)).toEqual(direct);
  });

  it("opens a link as written when the session kind is unknown", () => {
    expect(classifyTerminalUrl(null, "http://localhost:6006/")).toEqual(direct);
    expect(classifyTerminalUrl(undefined, "http://localhost:6006/")).toEqual(direct);
  });

  it("keeps the default endpoint for a localhost link with no port", () => {
    // URL drops the default port, so the tunnel dials 80: the endpoint the
    // link actually names, not the fixture's preview port.
    expect(classifyTerminalUrl("ssh", "http://localhost")).toEqual({
      ...forwarded,
      targetPort: 80,
    });
  });
});

describe("openSessionUrl", () => {
  it("waits for the tunnel's assigned port before opening path, query and hash", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValueOnce([]);
    deps.startForward.mockResolvedValue(row({ status: "starting", spec: spec(0) }));
    let release!: (rows: PortForward[]) => void;
    deps.listForwards.mockReturnValueOnce(
      new Promise<PortForward[]>((resolve) => {
        release = resolve;
      }),
    );
    const notify = vi.fn();
    const opening = previewOf(deps).openSessionUrl(
      "session-a",
      "ssh",
      "http://localhost:6006/app?tab=1#readme",
      notify,
    );
    await vi.waitFor(() => expect(deps.startForward).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      "Setting up a tunnel to http://localhost:6006/app?tab=1#readme…",
    );
    expect(deps.openUrl).not.toHaveBeenCalled();

    release([row({ spec: spec(41000) })]);
    await opening;
    expect(deps.startForward).toHaveBeenCalledWith("session-a", {
      direction: "local",
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: 6006,
    });
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:41000/app?tab=1#readme");
    expect(notify).toHaveBeenLastCalledWith(
      "Opened http://127.0.0.1:41000/app?tab=1#readme in the browser",
    );
    // The tunnel belongs to the tab until the user stops it in the Tunnels
    // list or the session closes: opening the page must not end it.
    expect(deps.stopForward).not.toHaveBeenCalled();
    expect(deps.removeForward).not.toHaveBeenCalled();
  });

  it("reuses a listening tunnel the same session already owns", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValue([
      row({ id: "existing", owner: "session-b", spec: spec(41001) }),
    ]);
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-b", "ssh", "http://localhost:6006/", notify);
    expect(deps.startForward).not.toHaveBeenCalled();
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:41001/");
    expect(notify).toHaveBeenCalledExactlyOnceWith("Opened http://127.0.0.1:41001/ in the browser");
  });

  it("shares the tunnel with a later click on another path of the same port", async () => {
    const deps = makeDeps();
    deps.listForwards
      .mockResolvedValueOnce([])
      .mockResolvedValue([row({ owner: "session-c", spec: spec(41002) })]);
    deps.startForward.mockResolvedValue(row({ status: "starting", spec: spec(0) }));
    const preview = previewOf(deps);
    await preview.openSessionUrl("session-c", "ssh", "http://localhost:6006/first");
    await preview.openSessionUrl("session-c", "ssh", "http://localhost:6006/second?x=1#top");
    expect(deps.startForward).toHaveBeenCalledTimes(1);
    expect(deps.openUrl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:41002/first",
      "http://127.0.0.1:41002/second?x=1#top",
    ]);
  });

  it("reopens a later click on the same address through the same tunnel", async () => {
    const deps = makeDeps();
    deps.listForwards
      .mockResolvedValueOnce([])
      .mockResolvedValue([row({ owner: "session-l", spec: spec(41008) })]);
    deps.startForward.mockResolvedValue(row({ status: "starting", spec: spec(0) }));
    const preview = previewOf(deps);
    await preview.openSessionUrl("session-l", "ssh", "http://localhost:6006/");
    // A new gesture, not a double click: the tab appears again, but the
    // forward that is already listening is reused rather than duplicated.
    await preview.openSessionUrl("session-l", "ssh", "http://localhost:6006/");
    expect(deps.startForward).toHaveBeenCalledTimes(1);
    expect(deps.openUrl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:41008/",
      "http://127.0.0.1:41008/",
    ]);
  });

  it("starts one tunnel for concurrent clicks and opens a double click once", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValueOnce([]);
    deps.startForward.mockResolvedValue(row({ status: "starting", spec: spec(0) }));
    deps.listForwards.mockResolvedValueOnce([row({ spec: spec(41003) })]);
    const preview = previewOf(deps);
    await Promise.all([
      preview.openSessionUrl("session-d", "ssh", "http://localhost:6006/one"),
      preview.openSessionUrl("session-d", "ssh", "http://localhost:6006/one"),
    ]);
    expect(deps.startForward).toHaveBeenCalledTimes(1);
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:41003/one");
  });

  it("gives each SSH session its own tunnel for the same remote port", async () => {
    const deps = makeDeps();
    let jobs: PortForward[] = [];
    let nextPort = 41000;
    deps.listForwards.mockImplementation(async () => jobs);
    deps.startForward.mockImplementation(async (owner: string, requested: PortForwardSpec) => {
      const listenPort = ++nextPort;
      const started = row({
        id: `job-${listenPort}`,
        owner,
        status: "starting",
        spec: { ...requested, listenPort: 0 },
      });
      jobs = [...jobs, { ...started, status: "listening", spec: { ...requested, listenPort } }];
      return started;
    });
    const preview = previewOf(deps);
    await Promise.all([
      preview.openSessionUrl("session-left", "ssh", "http://localhost:6006/"),
      preview.openSessionUrl("session-right", "ssh", "http://localhost:6006/"),
    ]);
    expect(deps.startForward).toHaveBeenCalledTimes(2);
    expect(deps.openUrl.mock.calls.map(([url]) => url).sort()).toEqual([
      "http://127.0.0.1:41001/",
      "http://127.0.0.1:41002/",
    ]);
  });

  it("opens a public address as written without starting a tunnel", async () => {
    const deps = makeDeps();
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-e", "ssh", "https://example.com/docs", notify);
    expect(deps.startForward).not.toHaveBeenCalled();
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    expect(notify).not.toHaveBeenCalled();
  });

  it("rewrites a wildcard link's target and keeps the link's scheme", async () => {
    const deps = makeDeps();
    deps.listForwards
      .mockResolvedValueOnce([])
      .mockResolvedValue([row({ spec: spec(41005, 3000) })]);
    deps.startForward.mockResolvedValue(row({ status: "starting", spec: spec(0) }));
    await previewOf(deps).openSessionUrl("session-f", "ssh", "https://0.0.0.0:3000/ui");
    expect(deps.startForward).toHaveBeenCalledWith("session-f", {
      direction: "local",
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: 3000,
    });
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("https://127.0.0.1:41005/ui");
  });

  it("opens an IPv6 listener through its bracketed loopback address", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValue([
      row({
        id: "IPv6",
        owner: "session-g",
        spec: {
          direction: "local",
          listenHost: "::1",
          listenPort: 41006,
          targetHost: "::1",
          targetPort: 6006,
        },
      }),
    ]);
    await previewOf(deps).openSessionUrl("session-g", "ssh", "http://[::1]:6006/");
    expect(deps.startForward).not.toHaveBeenCalled();
    expect(deps.openUrl).toHaveBeenCalledExactlyOnceWith("http://[::1]:41006/");
  });

  it("reports a refused start and opens nothing", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValue([]);
    deps.startForward.mockRejectedValue(new Error("SSH connection closed"));
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-h", "ssh", "http://localhost:6006/", notify);
    expect(deps.openUrl).not.toHaveBeenCalled();
    // The click announces the tunnel it starts, then the failure: the status
    // line's last word is the one that matters.
    expect(notify).toHaveBeenLastCalledWith(
      "Cannot open http://localhost:6006/: SSH connection closed",
      true,
    );
    expect(notify.mock.calls.length).toBe(2);
    expect(deps.stopForward).not.toHaveBeenCalled();
    expect(deps.removeForward).not.toHaveBeenCalled();
  });

  it("stops and removes a tunnel that fails before it listens", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValueOnce([]).mockResolvedValue([
      row({
        id: "job-failed",
        owner: "session-i",
        status: "error",
        error: "SSH connection closed",
      }),
    ]);
    deps.startForward.mockResolvedValue(
      row({ id: "job-failed", owner: "session-i", status: "starting", spec: spec(0) }),
    );
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-i", "ssh", "http://localhost:6006/", notify);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(
      "Cannot open http://localhost:6006/: SSH connection closed",
      true,
    );
    expect(notify.mock.calls.length).toBe(2);
    expect(deps.stopForward).toHaveBeenCalledWith("job-failed");
    expect(deps.removeForward).toHaveBeenCalledWith("job-failed");
  });

  it("gives up on a tunnel that never starts listening and removes it", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValueOnce([]).mockResolvedValue([
      row({
        id: "job-slow",
        owner: "session-j",
        status: "starting",
        spec: spec(0),
      }),
    ]);
    deps.startForward.mockResolvedValue(
      row({ id: "job-slow", owner: "session-j", status: "starting", spec: spec(0) }),
    );
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-j", "ssh", "http://localhost:6006/", notify);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(
      "Cannot open http://localhost:6006/: the tunnel did not start listening in time",
      true,
    );
    expect(notify.mock.calls.length).toBe(2);
    expect(deps.stopForward).toHaveBeenCalledWith("job-slow");
    expect(deps.removeForward).toHaveBeenCalledWith("job-slow");
    expect(deps.listForwards.mock.calls.length).toBeGreaterThan(2);
  });

  it("reports a browser launch failure and keeps the working tunnel", async () => {
    const deps = makeDeps();
    deps.listForwards.mockResolvedValue([row({ owner: "session-k", spec: spec(41004) })]);
    deps.openUrl.mockRejectedValue(new Error("Browser unavailable"));
    const notify = vi.fn();
    await previewOf(deps).openSessionUrl("session-k", "ssh", "http://localhost:6006/", notify);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Cannot open the link: Browser unavailable",
      true,
    );
    expect(deps.stopForward).not.toHaveBeenCalled();
    expect(deps.removeForward).not.toHaveBeenCalled();
  });
});

describe("openTerminalWebLink", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.listPortForwards.mockResolvedValue([]);
    mocks.startPortForward.mockResolvedValue(
      row({ id: "job-link", owner: "session-link", status: "starting", spec: spec(0) }),
    );
    mocks.stopPortForward.mockResolvedValue(undefined);
    mocks.removePortForward.mockResolvedValue(undefined);
  });

  const click = (init: MouseEventInit = {}) =>
    new MouseEvent("click", { bubbles: true, cancelable: true, ...init });

  it("does nothing without Ctrl or Cmd", async () => {
    const event = click();
    openTerminalWebLink(event, "http://localhost:6006/", {
      session: { id: "session-plain", kind: "ssh", connected: true },
    });
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.startPortForward).not.toHaveBeenCalled();
  });

  it("opens a public link directly on Ctrl+click", async () => {
    const event = click({ ctrlKey: true });
    openTerminalWebLink(event, "https://example.com/docs", {
      session: { id: "session-public", kind: "ssh", connected: true },
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs"),
    );
    expect(mocks.startPortForward).not.toHaveBeenCalled();
  });

  it("opens a loopback link through the connected SSH session's tunnel", async () => {
    mocks.listPortForwards
      .mockResolvedValueOnce([])
      .mockResolvedValue([row({ id: "job-link", owner: "session-link", spec: spec(41007) })]);
    const status = vi.fn();
    openTerminalWebLink(click({ ctrlKey: true }), "http://localhost:6006/app", {
      session: { id: "session-link", kind: "ssh", connected: true },
      onStatus: status,
    });
    await vi.waitFor(() =>
      expect(mocks.startPortForward).toHaveBeenCalledWith("session-link", {
        direction: "local",
        listenHost: "127.0.0.1",
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: 6006,
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:41007/app"),
    );
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith("Opened http://127.0.0.1:41007/app in the browser"),
    );
  });

  it("opens a loopback link as written when the SSH session is not connected", async () => {
    openTerminalWebLink(click({ ctrlKey: true }), "http://localhost:6006/", {
      session: { id: "session-off", kind: "ssh", connected: false },
    });
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:6006/"),
    );
    expect(mocks.startPortForward).not.toHaveBeenCalled();
  });

  it("opens a loopback link as written from a session that is not SSH", async () => {
    openTerminalWebLink(click({ ctrlKey: true }), "http://localhost:6006/", {
      session: { id: "session-local", kind: "local", connected: true },
    });
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:6006/"),
    );
    expect(mocks.startPortForward).not.toHaveBeenCalled();
  });

  it("accepts Cmd+click, which is the macOS form of the same gesture", async () => {
    openTerminalWebLink(click({ metaKey: true }), "https://example.com/", {
      session: { id: "session-mac", kind: "ssh", connected: true },
    });
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/"),
    );
  });
});
