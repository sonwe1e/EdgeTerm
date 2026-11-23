import { beforeEach, describe, expect, it } from "vitest";

import { useStore, type Tab } from "./store";

const tab = (id: string, paneId = "left"): Tab => ({
  info: {
    id,
    name: id,
    kind: "ssh",
    protocol: "ssh",
    profileId: null,
    address: id + ".internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-" + id, name: id, kind: "ssh" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId,
});

const attentionOf = (id: string) =>
  useStore.getState().tabs.find((item) => item.info.id === id)?.attention;

beforeEach(() => {
  useStore.setState({
    tabs: [tab("here"), tab("away")],
    panes: [
      { id: "left", activeTabId: "here" },
      { id: "right", activeTabId: "away" },
    ],
    activeId: "here",
    activePaneId: "left",
    status: "",
  });
});

describe("bell attention", () => {
  it("badges a background tab", () => {
    useStore.getState().noteTabBell("away");
    expect(attentionOf("away")).toBe(true);
    expect(attentionOf("here"), "the visible tab is not marked").toBeUndefined();
  });

  it("does not badge the tab the reader is looking at", () => {
    useStore.getState().noteTabBell("here");
    expect(attentionOf("here")).toBeUndefined();
  });

  it("keeps one badge until the tab is selected", () => {
    useStore.getState().noteTabBell("away");
    useStore.getState().noteTabBell("away");
    expect(attentionOf("away")).toBe(true);
    useStore.getState().setActive("away");
    expect(attentionOf("away")).toBeUndefined();
  });

  it("does not hand out a new tab list when there is nothing to change", () => {
    const before = useStore.getState().tabs;
    useStore.getState().noteTabBell("here");
    expect(useStore.getState().tabs, "the active tab was skipped").toBe(before);
  });
});
