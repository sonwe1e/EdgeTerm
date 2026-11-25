import { adjacentPane, removePane as removePaneFromLayout } from "./layout";
import { AppStore, DropTarget, Pane, Tab } from "./storeTypes";
import type { SessionInfo } from "./types";

/**
 * What makes two tabs "the same session" for `Tab.ordinal`: the profile when
 * there is one, else the name (ad-hoc connections have no profile).
 */
export const sessionKey = (info: SessionInfo): string => info.profileId ?? info.name;

/**
 * The name a tab is shown under: the name the user gave it, or the session's
 * name plus its ordinal. A custom name replaces the ordinal suffix too — the
 * point of naming a tab is to stop guessing which of the two it is.
 */
export const tabTitle = (tab: Pick<Tab, "info" | "ordinal"> & { title?: string }): string => {
  const custom = tab.title?.trim();
  if (custom) return custom;
  return tab.ordinal ? `${tab.info.name} (${tab.ordinal})` : tab.info.name;
};

export const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

/** Selecting a tab acknowledges its unread completion and its bell. */
export const acknowledgeTab = (tabs: Tab[], id: string | null): Tab[] => {
  const unread = (tab: Tab) => tab.commandActivity === "complete" || tab.attention === true;
  // The same array when there is nothing to acknowledge, so selecting a tab
  // does not hand every subscriber of `tabs` a new list to re-render from.
  if (id === null || !tabs.some((tab) => tab.info.id === id && unread(tab))) return tabs;
  return tabs.map((tab) =>
    tab.info.id === id && unread(tab)
      ? { ...tab, commandActivity: "idle", attention: undefined }
      : tab,
  );
};

let paneCounter = 0;

export const newPaneId = (): string => `pane-${++paneCounter}`;

export const ROOT_PANE_ID = newPaneId();

export const patchPane = (panes: Pane[], id: string, patch: Partial<Pane>): Pane[] =>
  panes.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane));

/**
 * Puts a tab into `paneId` at `index` counted over that pane's other tabs.
 * Tabs stay one flat list in opening order — a pane's strip is the tabs
 * carrying its id, in list order — so a move only shifts the tab to just
 * before the strip's tab that ends up after it.
 */
/**
 * Keeps the pinned region at the front of a strip while a drag is in flight:
 * a pinned tab cannot leave it and an unpinned one cannot enter it. `index`
 * is in "the strip's other tabs" space, the way `placeTab` reads it.
 */
export const clampStripIndex = (
  strip: readonly { pinned?: boolean }[],
  pinned: boolean,
  index: number,
  arriving = false,
): number => {
  const pinnedCount = strip.filter((item) => item.pinned).length;
  const floor = pinned ? 0 : pinnedCount;
  // A pinned tab already in the strip counts itself, so it can reach the last
  // pin at most; one arriving from another strip may land after every pin.
  // `strip.length` is "after the last tab", which `placeTab` accepts: moving a
  // tab to the end of its strip has to keep working.
  const ceiling = pinned ? Math.max(0, pinnedCount - (arriving ? 0 : 1)) : strip.length;
  return Math.max(floor, Math.min(index, ceiling));
};

export const placeTab = (tabs: Tab[], id: string, paneId: string, index: number): Tab[] => {
  const tab = tabs.find((item) => item.info.id === id);
  if (!tab) return tabs;
  const rest = tabs.filter((item) => item.info.id !== id);
  const siblings = rest.filter((item) => item.paneId === paneId);
  const to = Math.max(0, Math.min(index, siblings.length));
  const at =
    to < siblings.length
      ? rest.indexOf(siblings[to])
      : siblings.length > 0
        ? rest.indexOf(siblings[siblings.length - 1]) + 1
        : rest.length;
  const placed = [...rest];
  placed.splice(at, 0, tab.paneId === paneId ? tab : { ...tab, paneId });
  return placed;
};

export type PaneState = Pick<AppStore, "tabs" | "activeId" | "panes" | "layout" | "activePaneId">;

export const paneState = (state: PaneState): PaneState => ({
  tabs: state.tabs,
  activeId: state.activeId,
  panes: state.panes,
  layout: state.layout,
  activePaneId: state.activePaneId,
});

/**
 * Settles a pane after a tab left it (closed, or moved to another pane):
 * the pane shows its last tab if the one it showed is gone, or, with no tab
 * left, folds away and hands the focus it had to the pane before it. The
 * only pane stays, empty.
 */
export const settlePane = (state: PaneState, paneId: string): PaneState => {
  const pane = state.panes.find((item) => item.id === paneId);
  if (!pane) return state;
  const remaining = state.tabs.filter((tab) => tab.paneId === paneId);
  const focused = state.activePaneId === paneId;
  if (remaining.length > 0) {
    if (remaining.some((tab) => tab.info.id === pane.activeTabId)) return state;
    const activeTabId = remaining[remaining.length - 1].info.id;
    return {
      ...state,
      panes: patchPane(state.panes, paneId, { activeTabId }),
      activeId: focused ? activeTabId : state.activeId,
    };
  }
  if (state.panes.length === 1) {
    return {
      ...state,
      panes: patchPane(state.panes, paneId, { activeTabId: null }),
      activeId: focused ? null : state.activeId,
    };
  }
  const layout = removePaneFromLayout(state.layout, paneId) ?? state.layout;
  const panes = state.panes.filter((item) => item.id !== paneId);
  if (!focused) return { ...state, layout, panes };
  const nextId = adjacentPane(state.layout, paneId, -1);
  const next = panes.find((item) => item.id === nextId) ?? panes[0];
  return {
    ...state,
    layout,
    panes,
    activePaneId: next.id,
    activeId: next.activeTabId,
  };
};

export const sameDropTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.paneId === b.paneId &&
    a.zone === b.zone &&
    (a.zone !== "strip" || b.zone !== "strip" || a.index === b.index));
