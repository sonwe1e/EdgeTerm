import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  openSession: vi.fn(),
  writeSession: vi.fn(async () => undefined),
  resizeSession: vi.fn(async () => undefined),
  closeSession: vi.fn(async () => undefined),
}));

import * as api from "./api";
import { ensureController } from "./actions";
import { useStore, type Tab } from "./store";
import { disposeController } from "./terminalRegistry";
import type { SessionProfile } from "./types";

const initialState = useStore.getState();

const profile = (id: string): SessionProfile => ({ id, name: id, kind: "local" });

const makeTab = (id: string, state: Tab["state"]): Tab => ({
  info: {
    id,
    profileId: id,
    name: id,
    kind: "local",
    protocol: "shell",
    address: "default shell",
    color: "#4ea1f3",
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: profile(id),
  number: 1,
  ordinal: 0,
  state,
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initialState.activePaneId,
});

/** The handler xterm's `onData` is registered with. */
const press = (controller: unknown, data: string) =>
  (controller as { handleData(data: string): void }).handleData(data);

const ids: string[] = [];

/** A tab in `state`, with the terminal `ensureController` wires for it. */
async function ended(id: string, state: Tab["state"] = "closed") {
  ids.push(id);
  useStore.setState({
    tabs: [...useStore.getState().tabs, makeTab(id, state)],
    activeId: id,
    panes: [{ id: initialState.activePaneId, activeTabId: id }],
  });
  const controller = await ensureController(id);
  controller.setLocked(state === "closed" || state === "error");
  return controller;
}

beforeEach(() => {
  vi.mocked(api.openSession).mockReset();
  // Never settles: the test only looks at whether a connect was started.
  vi.mocked(api.openSession).mockReturnValue(new Promise(() => {}));
  useStore.setState({ ...initialState, tabs: [], hostKeyPrompt: null }, true);
});

afterEach(() => {
  for (const id of ids.splice(0)) disposeController(id);
});

describe("Enter on an ended session, through the wiring in actions.ts", () => {
  it("uses the current automatic reuse preference at the actual reconnect call", async () => {
    useStore.getState().setSshAutoReuse(false);
    const controller = await ended("reuse-off");
    press(controller, "\r");
    expect(vi.mocked(api.openSession).mock.calls[0][4]).toBe(false);
  });
  it("opens the session again for a closed tab", async () => {
    const controller = await ended("wired-closed");
    press(controller, "\r");
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.openSession).mock.calls[0][0]).toMatchObject({ id: "wired-closed" });
    expect(vi.mocked(api.openSession).mock.calls[0][1]).toBe("wired-closed");
  });

  it("opens the session again for a tab whose connection failed", async () => {
    const controller = await ended("wired-error", "error");
    press(controller, "\r");
    expect(api.openSession).toHaveBeenCalledTimes(1);
  });

  it("leaves the next attempt to the host key dialog while it is open", async () => {
    const controller = await ended("wired-hostkey");
    useStore.getState().setHostKeyPrompt({
      sessionId: "wired-hostkey",
      profile: profile("wired-hostkey"),
      change: {
        host: "example",
        port: 22,
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:new",
        publicKey: "ssh-ed25519 AAAA",
        knownHosts: "known_hosts",
        line: 1,
        message: "changed",
      },
    });
    press(controller, "\r");
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it("does not start a connect for a session that is already live", async () => {
    const controller = await ended("wired-live", "connected");
    press(controller, "\r");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.writeSession).toHaveBeenCalledWith("wired-live", "\r");
  });
});
