import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches platform.ts through the shortcut table, and IS_MAC is a
// build-time constant vitest does not define.
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));

import { useActiveTab, useStore, type Tab } from "./store";

const initialState = useStore.getState();

const makeTab = (id: string): Tab => ({
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
  profile: { id, name: id, kind: "local" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: initialState.activePaneId,
});

let renders = 0;

/** Reads the active tab and nothing else: a resize cannot change what it shows. */
function NameOnly() {
  const tab = useActiveTab();
  renders += 1;
  return h("div", null, tab?.info.name ?? "none");
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useStore.setState(
    {
      ...initialState,
      tabs: [makeTab("one"), makeTab("two")],
      activeId: "one",
      panes: [{ id: initialState.activePaneId, activeTabId: "one" }],
    },
    true,
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initialState, true);
});

describe("a terminal resize", () => {
  it("does not re-render a component that only reads the active tab", () => {
    act(() => root.render(h(NameOnly)));
    expect(renders).toBe(1);

    renders = 0;
    // A drag reports a new grid on every frame, and each report is its own
    // commit, so this models 60 painted frames rather than one batch.
    for (let cols = 100; cols < 160; cols += 1) {
      act(() => useStore.getState().setSize("one", cols, 40));
    }

    expect(renders).toBe(0);
  });

  it("keeps the published grid for the status bar", () => {
    useStore.getState().setSize("one", 120, 40);
    expect(useStore.getState().tabSizes.one).toEqual({ cols: 120, rows: 40 });
    // Two tabs share no cell: each session keeps its own grid.
    expect(useStore.getState().tabSizes.two).toBeUndefined();
  });

  it("stores nothing for a session that is already gone", () => {
    useStore.getState().setSize("closed-elsewhere", 100, 30);
    expect(useStore.getState().tabSizes["closed-elsewhere"]).toBeUndefined();
  });
});
