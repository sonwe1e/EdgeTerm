import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSession } from "../actions";
import { useStore, type Tab } from "../store";
import { connectedTabFor, ensureSessionFor, resolveProfile, terminalCommandFor } from "./session";

vi.mock("../actions", () => ({ openSession: vi.fn() }));

const server = {
  profileId: "p1",
  name: "gpu-01",
  host: "10.0.0.5",
  port: 22,
  username: "lab",
};

const profile = {
  id: "p1",
  name: "gpu-01",
  kind: "ssh" as const,
  host: "10.0.0.5",
  port: 22,
  username: "lab",
  auth: "password" as const,
};

const tab = (address: string, profileId = "p1", username = "lab"): Tab =>
  ({
    info: {
      id: "s1",
      profileId,
      name: "gpu-01",
      kind: "ssh",
      protocol: "ssh",
      address,
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { ...profile, id: profileId, username },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "root",
  }) as unknown as Tab;

describe("server identity resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ profiles: [profile], tabs: [] });
  });

  it("matches a saved login by id and endpoint", () => {
    expect(resolveProfile(server)).toEqual({
      profile,
      exact: true,
      drift: false,
    });
  });

  it("reports a saved login whose host moved instead of dialling it", async () => {
    useStore.setState({
      profiles: [{ ...profile, host: "10.0.0.9" }],
    });
    const match = resolveProfile(server);
    expect(match.drift).toBe(true);
    await expect(ensureSessionFor(server)).rejects.toThrow(/another host|其他主机/);
    expect(vi.mocked(openSession)).not.toHaveBeenCalled();
  });

  it("accepts a recreated profile only when the endpoint and user match", () => {
    useStore.setState({
      profiles: [{ ...profile, id: "p2" }],
    });
    expect(resolveProfile(server).profile?.id).toBe("p2");
    expect(resolveProfile(server).exact).toBe(false);
  });

  it("only returns a live tab on the project's endpoint", () => {
    useStore.setState({ tabs: [tab("10.0.0.9:22")] });
    expect(connectedTabFor(server)).toBeUndefined();
    useStore.setState({ tabs: [tab("10.0.0.5:22")] });
    expect(connectedTabFor(server)?.info.id).toBe("s1");
  });

  it("does not take another user's tab on the same host and port", () => {
    useStore.setState({ tabs: [tab("10.0.0.5:22", "p9", "other")] });
    expect(connectedTabFor(server)).toBeUndefined();
  });

  it("puts a project terminal in its root and environment", () => {
    expect(terminalCommandFor("/data/vfi base", "conda activate vfi")).toBe(
      "cd -- '/data/vfi base' && conda activate vfi",
    );
    expect(terminalCommandFor("/data/base", "")).toBe("cd -- '/data/base'");
  });
});
