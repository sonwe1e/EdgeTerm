// IX-04 — the Session panel's power button is the most visible connect /
// disconnect switch, so a connect in flight must stay cancellable there (the
// 2026-10-19 audit claimed it was; the code had it disabled instead). The
// button used to be `disabled` while `connecting`, so the first thing a user
// tried on a stuck connection did nothing; cancelling only existed in the
// Session menu. The regression: connecting keeps the button live, and a click
// runs the real cancel path (toggleSessionConnection → disconnectSession).
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../../nativeDialog", () => ({ ask: vi.fn(async () => true), open: vi.fn(), save: vi.fn() }));
vi.mock("../../api", async (original) => ({
  ...await original<typeof import("../../api")>(),
  closeSession: vi.fn(async () => {}),
  listSenderCommands: vi.fn(async () => []),
}));

import * as api from "../../api";
import { useStore, type Tab } from "../../store";
import { SessionPanel } from "./SessionPanel";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const tab = (id: string, state: Tab["state"]): Tab => ({
  info: {
    id, profileId: "p1", name: "web-prod-01", kind: "ssh", protocol: "ssh",
    address: "10.0.1.11:22", color: null, supportsRemoteFiles: true, recording: null,
    legacyAlgorithms: [], sharedConnection: false,
  },
  profile: { id: "p1", name: "web-prod-01", kind: "ssh", host: "10.0.1.11", port: 22, username: "deploy" },
  number: 1, ordinal: 0, state,
  commandActivity: "idle", activityKind: "command", cols: 80, rows: 24,
  paneId: initialState.activePaneId,
});

const power = () => host.querySelector<HTMLButtonButton>(".panel-power");
type HTMLButtonButton = HTMLButtonElement;

const mount = () => act(() => {
  root.render(h(SessionPanel, { onEditProfile: vi.fn(), onNewSession: vi.fn() }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", tabs: [], activeId: null, profiles: [], groups: [] }, true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Session panel power button (IX-04)", () => {
  it("stays live while connecting and cancels the attempt when clicked", async () => {
    const connecting = tab("sess-connecting", "connecting");
    useStore.setState({
      tabs: [connecting],
      activeId: connecting.info.id,
      panes: [{ id: initialState.activePaneId, activeTabId: connecting.info.id }],
    });
    mount();

    // The defect: disabled while connecting, so the click did nothing.
    expect(power()!.disabled).toBe(false);

    await act(async () => {
      power()!.click();
    });

    expect(api.closeSession).toHaveBeenCalledWith(connecting.info.id);
    const after = useStore.getState().tabs.find((item) => item.info.id === connecting.info.id);
    expect(after?.state).toBe("closed");
    expect(useStore.getState().status).toBeTruthy();
  });

  it("still disconnects a connected session", async () => {
    const connected = tab("sess-connected", "connected");
    useStore.setState({
      tabs: [connected],
      activeId: connected.info.id,
      panes: [{ id: initialState.activePaneId, activeTabId: connected.info.id }],
    });
    mount();

    expect(power()!.disabled).toBe(false);
    await act(async () => {
      power()!.click();
    });

    expect(api.closeSession).toHaveBeenCalledWith(connected.info.id);
  });

  it("has nothing to act on without an active session", () => {
    useStore.setState({ tabs: [], activeId: null });
    mount();
    expect(power()!.disabled).toBe(true);
  });
});
