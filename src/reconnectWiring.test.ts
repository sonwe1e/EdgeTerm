import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  openSession: vi.fn(),
  writeSession: vi.fn(async () => undefined),
  resizeSession: vi.fn(async () => undefined),
  closeSession: vi.fn(async () => undefined),
  stopRemoteEdits: vi.fn(async () => undefined),
  answerAuthPrompt: vi.fn(async () => undefined),
}));

import * as api from "./api";
import {
  disconnectSession,
  ensureController,
  openSession,
  reconnectSession,
  shouldApplySessionState,
} from "./actions";
import { useStore, type Tab } from "./store";
import { disposeController, getController } from "./terminalRegistry";
import type { OpenSessionOutcome, SessionProfile } from "./types";

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
  vi.mocked(api.closeSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.stopRemoteEdits).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.answerAuthPrompt).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.writeSession).mockClear();
  vi.mocked(api.resizeSession).mockClear();
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

  it("reconnects with the saved profile, not the copy the tab opened with", async () => {
    const controller = await ended("wired-edited");
    useStore.setState({
      profiles: [{ id: "wired-edited", name: "edited", kind: "local", shell: "/bin/zsh" }],
    });
    press(controller, "\r");

    expect(vi.mocked(api.openSession).mock.calls[0][0]).toMatchObject({
      id: "wired-edited",
      shell: "/bin/zsh",
    });
  });

  it("does not start a connect for a session that is already live", async () => {
    const controller = await ended("wired-live", "connected");
    press(controller, "\r");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.writeSession).toHaveBeenCalledWith("wired-live", "\r");
  });

  it("cancels a connect that is still negotiating instead of ignoring the request", async () => {
    const id = "wired-connecting";
    ids.push(id);
    useStore.setState({
      tabs: [...useStore.getState().tabs, makeTab(id, "connecting")],
      activeId: id,
      panes: [{ id: initialState.activePaneId, activeTabId: id }],
    });
    await ensureController(id);
    await disconnectSession(id);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("closed");
    expect(api.closeSession).toHaveBeenCalledWith(id);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const connected = (id: string, name = id): OpenSessionOutcome => ({
  status: "connected",
  info: { ...makeTab(id, "connected").info, name },
});

describe("connection attempt ownership", () => {
  it("waits for the cancelled handshake and its cleanup before reopening the same id", async () => {
    const id = "cancel-then-retry";
    await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    const nextOpen = deferred<OpenSessionOutcome>();
    const oldCleanup = deferred<void>();
    vi.mocked(api.openSession)
      .mockReturnValueOnce(oldOpen.promise)
      .mockReturnValueOnce(nextOpen.promise);
    vi.mocked(api.closeSession)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(oldCleanup.promise);

    const first = reconnectSession(id);
    await disconnectSession(id);
    const second = reconnectSession(id);
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(shouldApplySessionState(id)).toBe(false);

    oldOpen.resolve(connected(id, "cancelled attempt"));
    await tick();
    expect(api.closeSession).toHaveBeenCalledTimes(2);
    expect(api.openSession).toHaveBeenCalledTimes(1);
    oldCleanup.resolve(undefined);
    await first;
    await tick();
    expect(api.openSession).toHaveBeenCalledTimes(2);
    expect(shouldApplySessionState(id)).toBe(true);

    nextOpen.resolve(connected(id, "current attempt"));
    await second;
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)).toMatchObject({
      state: "connected",
      info: { name: "current attempt" },
    });
    expect(api.closeSession).toHaveBeenCalledTimes(2);
  });

  it("also waits for the cancellation close when the old handshake already rejected", async () => {
    const id = "cancel-close-pending";
    await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    const nextOpen = deferred<OpenSessionOutcome>();
    const cancellationClose = deferred<void>();
    vi.mocked(api.openSession)
      .mockReturnValueOnce(oldOpen.promise)
      .mockReturnValueOnce(nextOpen.promise);
    vi.mocked(api.closeSession).mockReturnValueOnce(cancellationClose.promise);

    const first = reconnectSession(id);
    const cancelling = disconnectSession(id);
    const second = reconnectSession(id);
    oldOpen.reject(new Error("cancelled negotiation"));
    await first;
    await tick();
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("connecting");

    cancellationClose.resolve(undefined);
    await cancelling;
    await tick();
    expect(api.openSession).toHaveBeenCalledTimes(2);
    nextOpen.resolve(connected(id));
    await second;
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("connected");
  });

  it("drops cancelled output but releases its flow-control credit", async () => {
    const id = "cancelled-output";
    const controller = await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    vi.mocked(api.openSession).mockReturnValueOnce(oldOpen.promise);
    const first = reconnectSession(id);
    const output = vi.mocked(api.openSession).mock.calls[0][2];
    const write = vi.spyOn(controller, "write");
    await disconnectSession(id);
    const consumed = vi.fn();
    output(Uint8Array.of(65), consumed);
    expect(write).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
    expect(shouldApplySessionState(id)).toBe(false);
    oldOpen.reject(new Error("cancelled"));
    await first;
    expect(shouldApplySessionState(id)).toBe(false);
  });

  it("does not open a backend session or keep a controller after its lazy-loading tab closes", async () => {
    const id = "close-during-terminal-import";
    ids.push(id);
    vi.mocked(api.openSession).mockResolvedValueOnce(connected(id));
    const opening = openSession(profile(id), undefined, id);
    useStore.setState({ tabs: [], activeId: null });
    await opening;
    expect(api.openSession).not.toHaveBeenCalled();
    expect(getController(id)).toBeUndefined();
  });

  it("keeps an initial lazy-loading session cancelled before a controller exists", async () => {
    const id = "cancel-during-terminal-import";
    ids.push(id);
    vi.mocked(api.openSession).mockResolvedValue(connected(id));

    const opening = openSession(profile(id), undefined, id);
    const cancelling = disconnectSession(id);
    await cancelling;
    await expect(opening).resolves.toBeNull();
    expect(api.openSession).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("closed");
    press(getController(id), "must stay local");
    expect(api.writeSession).not.toHaveBeenCalled();
  });

  it("does not let a cancelled lazy open supersede a deliberate newer retry", async () => {
    const id = "retry-before-terminal-import";
    ids.push(id);
    vi.mocked(api.openSession).mockResolvedValue(connected(id, "new retry"));

    const opening = openSession(profile(id), undefined, id);
    const cancelling = disconnectSession(id);
    const retry = reconnectSession(id);
    await cancelling;
    await expect(opening).resolves.toBeNull();
    await expect(retry).resolves.toBe(id);
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("connected");
  });

  it("locks a controller first created after its tab already ended", async () => {
    const id = "controller-created-after-close";
    ids.push(id);
    useStore.setState({ tabs: [makeTab(id, "closed")], activeId: id });
    const controller = await ensureController(id);
    press(controller, "must stay local");
    expect(api.writeSession).not.toHaveBeenCalled();
    press(controller, "\r");
    expect(api.openSession).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated close requests while a closed tab is still cleaning up", async () => {
    const id = "repeated-close-requests";
    await ended(id);
    const closingBackend = deferred<void>();
    const stoppedEdits = deferred<void>();
    vi.mocked(api.closeSession).mockReturnValue(closingBackend.promise);
    vi.mocked(api.stopRemoteEdits).mockReturnValueOnce(stoppedEdits.promise);

    useStore.getState().requestCloseTabs([id]);
    useStore.getState().requestCloseTabs([id]);
    closingBackend.resolve(undefined);
    await tick();
    const closeCalls = vi.mocked(api.closeSession).mock.calls.length;
    const stopCalls = vi.mocked(api.stopRemoteEdits).mock.calls.length;
    const stillClosing = useStore.getState().tabs.some((tab) => tab.info.id === id);
    stoppedEdits.resolve(undefined);
    await tick();

    expect(closeCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(stillClosing).toBe(true);
    expect(useStore.getState().tabs.some((tab) => tab.info.id === id)).toBe(false);
  });

  it("retires a late successful handshake while real closeTab is stopping remote edits", async () => {
    const id = "close-tab-during-handshake";
    const controller = await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    const stoppedEdits = deferred<void>();
    vi.mocked(api.openSession).mockReturnValueOnce(oldOpen.promise);
    vi.mocked(api.stopRemoteEdits).mockReturnValueOnce(stoppedEdits.promise);
    const opening = reconnectSession(id);
    const revision = controller.connectionRevision;
    const closing = useStore.getState().closeTab(id);
    await tick();
    expect(api.stopRemoteEdits).toHaveBeenCalledWith(id);
    expect(shouldApplySessionState(id)).toBe(false);
    expect(controller.connectionRevision).toBeGreaterThan(revision);

    oldOpen.resolve(connected(id, "too late"));
    await opening;
    expect(api.closeSession).toHaveBeenCalledTimes(2);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).not.toBe("connected");
    stoppedEdits.resolve(undefined);
    await closing;
    expect(useStore.getState().tabs.some((tab) => tab.info.id === id)).toBe(false);
    expect(getController(id)).toBeUndefined();
  });

  it("does not reconnect a closed tab while its closeTab cleanup is pending", async () => {
    const id = "reconnect-during-tab-close";
    await ended(id);
    const stoppedEdits = deferred<void>();
    vi.mocked(api.stopRemoteEdits).mockReturnValueOnce(stoppedEdits.promise);
    const closing = useStore.getState().closeTab(id);
    await tick();
    const result = reconnectSession(id);
    expect(api.openSession).not.toHaveBeenCalled();
    await expect(result).resolves.toBeNull();
    stoppedEdits.resolve(undefined);
    await closing;
  });

  it("withdraws an existing authentication question when connecting is cancelled", async () => {
    const id = "cancel-auth-question";
    await ended(id, "connecting");
    useStore.getState().addAuthPrompt({
      id: "old-auth-question",
      sessionId: id,
      address: "fixture:22",
      username: "alice",
      name: "",
      instructions: "",
      prompts: [{ prompt: "Verification code:", echo: false }],
    });
    await disconnectSession(id);
    expect(api.answerAuthPrompt).toHaveBeenCalledWith("old-auth-question", null);
    expect(useStore.getState().authPrompts).toEqual([]);
  });

  it("does not open over an old session when cancellation cleanup keeps failing", async () => {
    const id = "failed-cancel-cleanup";
    await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    vi.mocked(api.openSession).mockReturnValueOnce(oldOpen.promise);
    vi.mocked(api.closeSession)
      .mockRejectedValueOnce(new Error("cancel close failed"))
      .mockRejectedValueOnce(new Error("old session cleanup failed"))
      .mockRejectedValueOnce(new Error("cleanup still failing"));
    const first = reconnectSession(id);
    await disconnectSession(id);
    const retry = reconnectSession(id);
    oldOpen.resolve(connected(id));
    await first;
    await retry;
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(api.closeSession).toHaveBeenCalledTimes(3);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("error");

    vi.mocked(api.closeSession).mockResolvedValueOnce(undefined);
    vi.mocked(api.openSession).mockResolvedValueOnce(connected(id, "clean retry"));
    await reconnectSession(id);
    expect(api.closeSession).toHaveBeenCalledTimes(4);
    expect(api.openSession).toHaveBeenCalledTimes(2);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("connected");
  });

  it("does not run a queued retry after that retry was cancelled too", async () => {
    const id = "cancel-queued-retry";
    await ended(id);
    const oldOpen = deferred<OpenSessionOutcome>();
    vi.mocked(api.openSession).mockReturnValueOnce(oldOpen.promise);
    const first = reconnectSession(id);
    await disconnectSession(id);
    const retry = reconnectSession(id);
    await disconnectSession(id);
    oldOpen.resolve(connected(id));
    await Promise.all([first, retry]);
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("closed");
    expect(shouldApplySessionState(id)).toBe(false);
  });
});

describe("reconnect credential identity", () => {
  async function reconnectEdited(id: string, changes: Partial<SessionProfile>) {
    await ended(id);
    const original: SessionProfile = {
      id,
      name: id,
      kind: "ssh",
      host: "original.example",
      port: 22,
      username: "alice",
      auth: "publicKey",
      privateKeyPath: "/keys/original",
      password: "tab-only-password",
      passphrase: "tab-only-passphrase",
    };
    const saved = { ...original, password: undefined, passphrase: undefined, ...changes };
    useStore.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.info.id === id ? { ...tab, profile: original } : tab)),
      profiles: [saved],
    }));
    void reconnectSession(id);
    return vi.mocked(api.openSession).mock.calls[0][0];
  }

  it("keeps tab-only secrets for the same endpoint and key", async () => {
    expect(await reconnectEdited("same-credential-owner", { name: "renamed" })).toMatchObject({
      password: "tab-only-password",
      passphrase: "tab-only-passphrase",
    });
  });

  it.each([
    ["host", { host: "different.example" }],
    ["port", { port: 2222 }],
    ["username", { username: "bob" }],
    ["protocol", { kind: "sftp" as const }],
    ["authentication", { auth: "password" as const }],
    ["jump host", { jumpProfileId: "different-hop" }],
  ])("does not forward tab-only secrets after changing the %s", async (label, changes) => {
    const result = await reconnectEdited(`changed-credential-${label}`, changes);
    expect(result.password).toBeUndefined();
    expect(result.passphrase).toBeUndefined();
  });

  it("does not apply an old key's passphrase to a different private key", async () => {
    const result = await reconnectEdited("changed-key-identity", {
      privateKeyPath: "/keys/different",
    });
    expect(result.passphrase).toBeUndefined();
  });

  it("honors explicit replacement credentials for a changed host", async () => {
    const result = await reconnectEdited("explicit-new-credentials", {
      host: "different.example",
      password: "new-password",
      passphrase: "new-passphrase",
    });
    expect(result.password).toBe("new-password");
    expect(result.passphrase).toBe("new-passphrase");
  });
});
