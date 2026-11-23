import { afterEach, describe, expect, it } from "vitest";

import { tabTitle, useStore } from "./store";
import type { Tab } from "./storeTypes";

const tab = (id: string, name: string, ordinal = 0, title?: string): Tab =>
  ({
    info: { id, name },
    profile: { id: "p-" + id, name },
    number: 1,
    ordinal,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    paneId: "left",
    title,
  }) as unknown as Tab;

const initial = useStore.getState();

const titleOf = (id: string) => {
  const found = useStore.getState().tabs.find((item) => item.info.id === id);
  return found ? tabTitle(found) : null;
};

describe("tab titles", () => {
  afterEach(() => {
    useStore.setState(initial, true);
  });

  it("shows the session name with its ordinal until the user renames it", () => {
    expect(tabTitle(tab("a", "web", 0))).toBe("web");
    expect(tabTitle(tab("a", "web", 2))).toBe("web (2)");
  });

  it("a custom name replaces the session name and the ordinal suffix", () => {
    expect(tabTitle(tab("a", "web", 2, "  deploy db  "))).toBe("deploy db");
  });

  it("renames, trims, and clears back to the session name", () => {
    useStore.setState({ ...initial, tabs: [tab("a", "web"), tab("b", "api")] });
    useStore.getState().renameTab("a", "  staging web  ");
    expect(useStore.getState().tabs.find((item) => item.info.id === "a")?.title).toBe(
      "staging web",
    );
    expect(titleOf("a")).toBe("staging web");
    expect(titleOf("b"), "the other tab is untouched").toBe("api");

    useStore.getState().renameTab("a", "   ");
    expect(useStore.getState().tabs.find((item) => item.info.id === "a")?.title).toBeUndefined();
    expect(titleOf("a")).toBe("web");
  });

  it("ignores ids that are not open", () => {
    useStore.setState({ ...initial, tabs: [tab("a", "web")] });
    const before = useStore.getState().tabs;
    useStore.getState().renameTab("missing", "x");
    expect(useStore.getState().tabs).toBe(before);
  });

  it("a name equal to the shown name clears the custom title", () => {
    useStore.setState({ ...initial, tabs: [tab("a", "web"), tab("b", "api", 2)] });
    useStore.getState().renameTab("a", "web");
    expect(useStore.getState().tabs.find((item) => item.info.id === "a")?.title).toBeUndefined();
    useStore.getState().renameTab("b", "api (2)");
    expect(useStore.getState().tabs.find((item) => item.info.id === "b")?.title).toBeUndefined();
  });

  it("an unchanged rename keeps the tab list identity", () => {
    useStore.setState({ ...initial, tabs: [tab("a", "web")] });
    useStore.getState().renameTab("a", "deploy");
    const named = useStore.getState().tabs;
    useStore.getState().renameTab("a", "  deploy  ");
    expect(useStore.getState().tabs, "same trimmed value, same array").toBe(named);
    expect(useStore.getState().tabs.find((item) => item.info.id === "a")?.title).toBe("deploy");
  });
});
