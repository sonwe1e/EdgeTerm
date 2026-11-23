import { beforeEach, describe, expect, it } from "vitest";

import { useStore, type Tab } from "./store";

const tab = (): Tab => ({
  info: {
    id: "one",
    name: "one",
    kind: "ssh",
    protocol: "ssh",
    profileId: null,
    address: "one.internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-one", name: "one", kind: "ssh" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "left",
});

const title = () => useStore.getState().tabs[0].remoteTitle;

beforeEach(() => {
  useStore.setState({
    tabs: [tab()],
    panes: [{ id: "left", activeTabId: "one" }],
    activeId: "one",
    activePaneId: "left",
  });
});

describe("reported window title", () => {
  it("keeps what the program said", () => {
    useStore.getState().noteTabTitle("one", "vim notes.txt");
    expect(title()).toBe("vim notes.txt");
  });

  it("strips control characters and trims", () => {
    useStore.getState().noteTabTitle("one", "  vim\u0007 \u001bnotes  ");
    expect(title()).toBe("vim notes");
  });

  it("caps a hostile title", () => {
    useStore.getState().noteTabTitle("one", "x".repeat(400));
    expect(title()).toHaveLength(120);
  });

  it("clears when the program sets an empty title", () => {
    useStore.getState().noteTabTitle("one", "vim notes.txt");
    useStore.getState().noteTabTitle("one", "   ");
    expect(title()).toBeUndefined();
  });

  it("does not hand out a new list when nothing changed", () => {
    useStore.getState().noteTabTitle("one", "vim");
    const before = useStore.getState().tabs;
    useStore.getState().noteTabTitle("one", "vim");
    expect(useStore.getState().tabs).toBe(before);
  });
});
