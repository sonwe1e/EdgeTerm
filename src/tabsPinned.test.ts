import { afterEach, describe, expect, it } from "vitest";
import { closeOthersTargets, useStore } from "./store";
import type { Tab } from "./storeTypes";

const tab = (id: string, paneId = "left"): Tab =>
  ({
    info: { id, name: id },
    profile: { id: "p-" + id, name: id },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    paneId,
  }) as unknown as Tab;

const initial = useStore.getState();

describe("pinned tabs", () => {
  afterEach(() => {
    useStore.setState(initial, true);
  });

  it("parks a pinned tab at the front of its own strip", () => {
    useStore.setState({
      ...initial,
      tabs: [tab("a"), tab("b"), tab("c"), tab("other", "right")],
    });
    useStore.getState().toggleTabPinned("c");
    const ids = useStore.getState().tabs.map((item) => item.info.id);
    expect(ids, "only the pinned tab moved").toEqual(["c", "a", "b", "other"]);
    expect(useStore.getState().tabs[0].pinned).toBe(true);
  });

  it("unpins without moving the tab again", () => {
    useStore.setState({ ...initial, tabs: [tab("a"), tab("b")] });
    useStore.getState().toggleTabPinned("b");
    useStore.getState().toggleTabPinned("b");
    expect(useStore.getState().tabs.map((item) => item.info.id)).toEqual(["b", "a"]);
    expect(useStore.getState().tabs[0].pinned).toBe(false);
  });

  it("unpinning keeps the pinned region contiguous", () => {
    useStore.setState({ ...initial, tabs: [tab("a"), tab("b"), tab("c")] });
    for (const id of ["c", "b", "a"]) useStore.getState().toggleTabPinned(id);
    expect(
      useStore.getState().tabs.map((item) => item.info.id),
      "pin order",
    ).toEqual(["a", "b", "c"]);

    // Unpinning the middle one must not leave a hole between pinned tabs: the
    // drop floor for unpinned tabs is the pinned count, so a hole there made the
    // front slots unreachable.
    useStore.getState().toggleTabPinned("b");
    const tabs = useStore.getState().tabs;
    expect(tabs.map((item) => item.info.id)).toEqual(["a", "c", "b"]);
    expect(
      tabs.map((item) => item.pinned === true),
      "pinned first, unpinned after",
    ).toEqual([true, true, false]);
  });

  it("leaves pinned tabs out of Close Others, and the kept tab too", () => {
    const tabs = [{ ...tab("pinned"), pinned: true }, tab("middle"), tab("right"), tab("keep")];
    expect(closeOthersTargets(tabs, "keep")).toEqual(["middle", "right"]);
  });
});
