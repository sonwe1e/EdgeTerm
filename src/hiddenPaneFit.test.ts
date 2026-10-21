import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  writeSession: vi.fn(async () => undefined),
  resizeSession: vi.fn(async () => undefined),
}));

import { ensureController } from "./actions";
import { SessionPane } from "./components/TerminalPane";
import { useStore, type Tab } from "./store";
import { disposeController } from "./terminalRegistry";

const initialState = useStore.getState();

const tab: Tab = {
  info: {
    id: "fit-pane",
    profileId: "fit-pane",
    name: "fit-pane",
    kind: "local",
    protocol: "shell",
    address: "default shell",
    color: "#4ea1f3",
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "fit-pane", name: "fit-pane", kind: "local" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initialState.activePaneId,
};

let host: HTMLDivElement;
let root: Root;
let observers: (() => void)[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  disposeController(tab.info.id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const render = (visible: boolean) =>
  act(async () => root.render(h(SessionPane, { tab, visible, focused: false, style: {} })));

describe("a pane's resize observer, through SessionPane", () => {
  it("asks the terminal to fit when the pane is on screen", async () => {
    const controller = await ensureController(tab.info.id);
    const fit = vi.spyOn(controller, "scheduleFit");
    await render(true);
    fit.mockClear();

    act(() => observers.forEach((callback) => callback()));
    expect(fit).toHaveBeenCalled();
  });

  it("does not fit a terminal whose pane is hidden", async () => {
    const controller = await ensureController(tab.info.id);
    const fit = vi.spyOn(controller, "scheduleFit");
    await render(false);
    fit.mockClear();

    act(() => observers.forEach((callback) => callback()));
    expect(fit).not.toHaveBeenCalled();
  });
});
