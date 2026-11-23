import { beforeEach, describe, expect, it } from "vitest";

import { translate } from "./i18n";
import { useStore, type Tab } from "./store";
import type { SessionKind, SessionState } from "./types";

const tab = (id: string, kind: SessionKind, state: SessionState = "connected") =>
  ({ info: { id, kind }, state }) as unknown as Tab;

const setTabs = (tabs: Tab[], activeId: string, broadcastInput = false) =>
  useStore.setState({ tabs, activeId, broadcastInput, status: "" });

beforeEach(() => {
  useStore.setState({ tabs: [], activeId: null, broadcastInput: false, status: "" });
});

describe("setBroadcastInput", () => {
  it("switches on when another connected shell can receive the bytes", () => {
    setTabs([tab("a", "ssh"), tab("b", "local")], "a");
    useStore.getState().setBroadcastInput(true);
    expect(useStore.getState().broadcastInput).toBe(true);
    expect(useStore.getState().status).toBe(translate("en", "broadcast.on", { count: 1 }));
  });

  it("refuses, with the reason in the status bar, when nothing else is connected", () => {
    setTabs([tab("a", "ssh"), tab("b", "sftp"), tab("c", "ssh", "connecting")], "a");
    useStore.getState().setBroadcastInput(true);
    expect(useStore.getState().broadcastInput).toBe(false);
    expect(useStore.getState().status).toBe(translate("en", "broadcast.needsSecondSession"));
  });

  it("reports when it is switched off", () => {
    setTabs([tab("a", "ssh"), tab("b", "ssh")], "a", true);
    useStore.getState().setBroadcastInput(false);
    expect(useStore.getState().broadcastInput).toBe(false);
    expect(useStore.getState().status).toBe(translate("en", "broadcast.off"));
  });

  it("does nothing when the state already matches", () => {
    setTabs([tab("a", "ssh"), tab("b", "ssh")], "a", true);
    useStore.getState().setBroadcastInput(true);
    expect(useStore.getState().status).toBe("");
  });
});

describe("setBroadcastGroup", () => {
  const member = (id: string, groupId: string) =>
    ({ info: { id, kind: "ssh" }, state: "connected", profile: { groupId } }) as unknown as Tab;

  it("excludes a group's members and reports the smaller count", () => {
    useStore.setState({
      tabs: [member("a", "ops"), member("b", "prod"), member("c", "prod"), member("d", "lab")],
      activeId: "a",
      broadcastInput: true,
      broadcastExcluded: [],
      broadcastExcludedGroups: [],
      status: "",
    });
    useStore.getState().setBroadcastGroup("prod", false);
    expect(useStore.getState().broadcastExcludedGroups).toEqual(["prod"]);
    // d is still a recipient, so the mode stays on with a truthful count.
    expect(useStore.getState().broadcastInput).toBe(true);
    expect(useStore.getState().status).toBe(translate("en", "broadcast.on", { count: 1 }));
  });

  it("switches the mode off when the last recipient leaves with the group", () => {
    useStore.setState({
      tabs: [member("a", "ops"), member("b", "prod")],
      activeId: "a",
      broadcastInput: true,
      broadcastExcluded: [],
      broadcastExcludedGroups: [],
      status: "",
    });
    useStore.getState().setBroadcastGroup("prod", false);
    expect(useStore.getState().broadcastInput).toBe(false);
    expect(useStore.getState().status).toBe(translate("en", "broadcast.off"));
  });
});
