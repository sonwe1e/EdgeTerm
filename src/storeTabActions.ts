import type { StateCreator } from "zustand";
import * as api from "./api";
import { t } from "./i18n";
import { adjacentPane, resetSplit, resizeSplit, splitPane as splitPaneInLayout } from "./layout";
import {
  acknowledgeTab,
  clampStripIndex,
  newPaneId,
  paneState,
  patchPane,
  patchTab,
  placeTab,
  sameDropTarget,
  sessionKey,
  settlePane,
} from "./storeLayout";
import { AppStore, ClosedTab, Tab, TerminalSize } from "./storeTypes";
import { disposeController, getController } from "./terminalRegistry";
import {
  beginTabConnectionClose,
  closeConnection,
  endTabConnectionClose,
  holdConnectionCleanup,
  isConnectionClosing,
} from "./sessionConnectionLifecycle";

/** The published grids without `id`; the same record when it holds no entry. */
const dropSize = (sizes: Record<string, TerminalSize>, id: string) => {
  if (!(id in sizes)) return sizes;
  const next = { ...sizes };
  delete next[id];
  return next;
};

/** How many closed sessions stay reopenable. A safety net, not a log. */
const CLOSED_TAB_LIMIT = 10;

/**
 * What "Close Others" closes: everything but `keepId` and the pinned tabs.
 * Pinned is a promise that the tab survives the bulk closes, not the explicit
 * close, so it lives here where both the menu and any later caller share it.
 */
export const closeOthersTargets = (
  tabs: readonly { info: { id: string }; pinned?: boolean }[],
  keepId: string,
): string[] =>
  tabs.filter((tab) => tab.info.id !== keepId && !tab.pinned).map((tab) => tab.info.id);

/** Newest last, bounded: the order `takeClosedTab` pops from. */
export const pushClosedTab = (list: ClosedTab[], entry: ClosedTab): ClosedTab[] =>
  [...list, entry].slice(-CLOSED_TAB_LIMIT);

export const createTabActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "addTab"
    | "updateTabInfo"
    | "updateTabProfile"
    | "closeTab"
    | "requestCloseTab"
    | "requestCloseTabs"
    | "closedTabs"
    | "takeClosedTab"
    | "setClosePrompt"
    | "setActive"
    | "noteTabBell"
    | "noteTabTitle"
    | "setActivePane"
    | "activateAdjacentTab"
    | "activateAdjacentPane"
    | "moveTab"
    | "moveTabToPane"
    | "splitPane"
    | "zoomedPaneId"
    | "toggleZoomedPane"
    | "resizeLayout"
    | "resetSplitSizes"
    | "toggleTabPinned"
    | "renameTab"
    | "setTabDrag"
    | "applyState"
    | "markCommandStarted"
    | "markCommandCompleted"
    | "clearCommandActivity"
    | "setSize"
  >
> = (set, get) => ({
  closedTabs: [],
  zoomedPaneId: null,
  addTab(info, profile, state = "connected") {
    const { tabs, panes, activePaneId } = get();
    const taken = new Set(tabs.map((tab) => tab.number));
    let number = 1;
    while (taken.has(number)) number += 1;
    const key = sessionKey(info);
    const ordinals = new Set(
      tabs.filter((tab) => sessionKey(tab.info) === key).map((tab) => tab.ordinal),
    );
    let ordinal = 0;
    while (ordinals.has(ordinal)) ordinal += 1;
    const tab: Tab = {
      info,
      profile,
      number,
      ordinal,
      state,
      commandActivity: "idle",
      activityKind: "command",
      paneId: activePaneId,
    };
    set({
      tabs: [...tabs, tab],
      activeId: info.id,
      tabFocusTarget: "terminal",
      panes: patchPane(panes, activePaneId, { activeTabId: info.id }),
    });
  },

  updateTabInfo(id, info) {
    set({
      tabs: get().tabs.map((tab) => (tab.info.id === id ? { ...tab, info } : tab)),
    });
  },

  updateTabProfile(id, profile) {
    set({
      tabs: get().tabs.map((tab) => (tab.info.id === id ? { ...tab, profile } : tab)),
    });
  },

  async closeTab(id) {
    // Closed tabs bypass the confirmation dialog, so repeated clicks can
    // arrive while their first close is still waiting for IPC cleanup.
    if (isConnectionClosing(id) || !get().tabs.some((tab) => tab.info.id === id)) return;
    // Retire ownership before either await: a late handshake must not turn
    // this still-visible tab live again while its editor watchers stop.
    beginTabConnectionClose(id);
    getController(id)?.setLocked(true);
    try {
      for (const prompt of get().authPrompts) {
        if (prompt.sessionId === id) {
          void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
        }
      }
      set({
        authPrompts: get().authPrompts.filter((prompt) => prompt.sessionId !== id),
        hostKeyPrompt: get().hostKeyPrompt?.sessionId === id ? null : get().hostKeyPrompt,
      });
      const closing = closeConnection(id).catch(() => undefined);
      holdConnectionCleanup(id, closing);
      await closing;
      // Files from this session opened in local editors stop syncing back.
      await api.stopRemoteEdits(id).catch(() => undefined);
      disposeController(id);
      const current = get();
      const closingTab = current.tabs.find((tab) => tab.info.id === id);
      const remaining = current.tabs.filter((tab) => tab.info.id !== id);
      // The pane shows its last tab next, or folds away with its last tab.
      const settled = closingTab
        ? settlePane({ ...paneState(current), tabs: remaining }, closingTab.paneId)
        : { ...paneState(current), tabs: remaining };
      const clearsSessionError = current.errorSessionId === id;
      const closePrompt = current.closePrompt?.filter((pending) => pending !== id) ?? null;
      set({
        ...settled,
        tabFocusTarget: settled.activeId === current.activeId ? current.tabFocusTarget : "terminal",
        tabs: acknowledgeTab(settled.tabs, settled.activeId),
        status: clearsSessionError ? t("status.ready") : current.status,
        error: clearsSessionError ? null : current.error,
        errorSessionId: clearsSessionError ? null : current.errorSessionId,
        hostKeyPrompt: current.hostKeyPrompt?.sessionId === id ? null : current.hostKeyPrompt,
        pastePrompt: current.pastePrompt?.sessionId === id ? null : current.pastePrompt,
        clipboardPrompt: current.clipboardPrompt?.sessionId === id ? null : current.clipboardPrompt,
        authPrompts: current.authPrompts.filter((prompt) => prompt.sessionId !== id),
        closePrompt: closePrompt && closePrompt.length > 0 ? closePrompt : null,
        // Remember what was closed, newest last, bounded: reopened sessions
        // are a safety net, not a log.
        closedTabs: closingTab
          ? pushClosedTab(current.closedTabs, {
              info: closingTab.info,
              profile: closingTab.profile,
            })
          : current.closedTabs,
        tabSizes: dropSize(current.tabSizes, id),
      });
    } finally {
      endTabConnectionClose(id);
    }
  },

  takeClosedTab() {
    const closed = get().closedTabs;
    if (closed.length === 0) return null;
    const newest = closed[closed.length - 1];
    set({ closedTabs: closed.slice(0, -1) });
    return newest;
  },

  requestCloseTab(id) {
    get().requestCloseTabs([id]);
  },

  requestCloseTabs(ids) {
    const wanted = new Set(ids);
    const live: string[] = [];
    for (const tab of get().tabs) {
      if (!wanted.has(tab.info.id)) continue;
      if (tab.state === "closed" || tab.state === "error") {
        void get().closeTab(tab.info.id);
      } else {
        live.push(tab.info.id);
      }
    }
    if (live.length > 0) set({ closePrompt: live });
  },

  setClosePrompt(ids) {
    set({ closePrompt: ids && ids.length > 0 ? ids : null });
  },

  setActive(id, focusTarget = "terminal") {
    const { tabs, panes } = get();
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab) return;
    set({
      activeId: id,
      tabFocusTarget: focusTarget,
      activePaneId: tab.paneId,
      panes: patchPane(panes, tab.paneId, { activeTabId: id }),
      // A completion is deliberately persistent on a background tab, but
      // selecting it is the acknowledgement. A still-running command keeps
      // its state so the particles return if the user switches away again.
      tabs: acknowledgeTab(tabs, id),
    });
  },

  noteTabTitle(id, raw) {
    // A program may set a title of anything: clip the control characters and
    // the length, and treat "no title" as clearing what was there.
    const title = raw
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 120);
    const tab = get().tabs.find((item) => item.info.id === id);
    if (!tab || tab.remoteTitle === (title || undefined)) return;
    set({ tabs: patchTab(get().tabs, id, { remoteTitle: title || undefined }) });
  },

  noteTabBell(id) {
    const { tabs, activeId } = get();
    // A bell in the pane the reader is already looking at needs no badge: the
    // user is there, and a marker would only survive until the next click.
    if (id === activeId) return;
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab || tab.attention) return;
    set({ tabs: patchTab(tabs, id, { attention: true }) });
  },

  setActivePane(paneId) {
    const { panes, activePaneId, tabs } = get();
    const pane = panes.find((item) => item.id === paneId);
    if (!pane || paneId === activePaneId) return;
    set({
      activePaneId: paneId,
      activeId: pane.activeTabId,
      tabFocusTarget: "terminal",
      tabs: acknowledgeTab(tabs, pane.activeTabId),
    });
  },

  renameTab(id, title) {
    const tab = get().tabs.find((item) => item.info.id === id);
    if (!tab) return;
    const trimmed = title.trim();
    // Committing the name the tab already shows must not freeze a derived
    // title: an untouched Rename would otherwise survive later name changes.
    const plain = tab.ordinal ? `${tab.info.name} (${tab.ordinal})` : tab.info.name;
    const next = trimmed === "" || trimmed === plain ? undefined : trimmed;
    if (next === tab.title) return;
    set({ tabs: patchTab(get().tabs, id, { title: next }) });
  },

  toggleTabPinned(id) {
    const current = get();
    const tab = current.tabs.find((item) => item.info.id === id);
    if (!tab) return;
    const pinned = !tab.pinned;
    const tabs = current.tabs.map((item) => (item.info.id === id ? { ...item, pinned } : item));
    // Pinning parks the tab at the front of its own strip: the array order is
    // the display order, so no derived ordering is needed and drag-reorder
    // keeps working on the positions it sees.
    set({ tabs: pinned ? placeTab(tabs, id, tab.paneId, 0) : tabs });
  },

  activateAdjacentTab(direction) {
    const { tabs, activeId, activePaneId } = get();
    const strip = tabs.filter((tab) => tab.paneId === activePaneId);
    if (strip.length === 0) return;

    const activeIndex = strip.findIndex((tab) => tab.info.id === activeId);
    const startIndex = activeIndex === -1 ? (direction > 0 ? -1 : 0) : activeIndex;
    const nextIndex = (startIndex + direction + strip.length) % strip.length;
    get().setActive(strip[nextIndex].info.id);
  },

  activateAdjacentPane(direction) {
    const { layout, activePaneId } = get();
    const next = adjacentPane(layout, activePaneId, direction);
    if (next) get().setActivePane(next);
  },

  moveTab(id, index) {
    const tabs = get().tabs;
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab) return;
    const strip = tabs.filter((item) => item.paneId === tab.paneId);
    const from = strip.indexOf(tab);
    const to = Math.max(0, clampStripIndex(strip, tab.pinned === true, index));
    if (to === from) return;
    set({ tabs: placeTab(tabs, id, tab.paneId, to) });
  },

  moveTabToPane(id, paneId, index) {
    const current = get();
    const tab = current.tabs.find((item) => item.info.id === id);
    if (!tab || !current.panes.some((pane) => pane.id === paneId)) return;
    if (tab.paneId === paneId) {
      get().moveTab(id, index);
      return;
    }
    // The tab is shown and focused where it lands; then the pane it left
    // picks a new tab to show, or folds away.
    // The destination strip has its own pinned region: a drop can land
    // beside it, never inside it from the wrong side.
    const target = current.tabs.filter((item) => item.paneId === paneId);
    const settled = settlePane(
      {
        tabs: placeTab(
          current.tabs,
          id,
          paneId,
          clampStripIndex(target, tab.pinned === true, index, true),
        ),
        activeId: id,
        panes: patchPane(current.panes, paneId, { activeTabId: id }),
        layout: current.layout,
        activePaneId: paneId,
      },
      tab.paneId,
    );
    set({ ...settled, tabs: acknowledgeTab(settled.tabs, id), tabFocusTarget: "terminal" });
  },

  toggleZoomedPane() {
    const { zoomedPaneId, activePaneId } = get();
    set({ zoomedPaneId: zoomedPaneId === activePaneId ? null : activePaneId });
  },

  splitPane(paneId, side, tabId) {
    const current = get();
    if (!current.panes.some((pane) => pane.id === paneId)) {
      return current.activePaneId;
    }
    const tab = tabId ? current.tabs.find((item) => item.info.id === tabId) : undefined;
    if (tabId && !tab) return current.activePaneId;
    if (
      tab &&
      tab.paneId === paneId &&
      !current.tabs.some((item) => item.paneId === paneId && item.info.id !== tabId)
    ) {
      return paneId;
    }
    const newId = newPaneId();
    // A new pane the reader cannot see would look like a no-op: unzoom first.
    const layout = splitPaneInLayout(current.layout, paneId, side, newId);
    const panes = [...current.panes, { id: newId, activeTabId: tab?.info.id ?? null }];
    if (!tab) {
      set({
        layout,
        panes,
        activePaneId: newId,
        activeId: null,
        tabFocusTarget: "terminal",
        zoomedPaneId: null,
      });
      return newId;
    }
    const settled = settlePane(
      {
        tabs: placeTab(current.tabs, tab.info.id, newId, 0),
        activeId: tab.info.id,
        panes,
        layout,
        activePaneId: newId,
      },
      tab.paneId,
    );
    set({
      ...settled,
      tabs: acknowledgeTab(settled.tabs, tab.info.id),
      tabFocusTarget: "terminal",
      zoomedPaneId: null,
    });
    return newId;
  },

  resetSplitSizes(path, index) {
    const layout = get().layout;
    const reset = resetSplit(layout, path, index);
    if (reset !== layout) set({ layout: reset });
  },

  resizeLayout(path, index, delta, minSize) {
    const layout = get().layout;
    const resized = resizeSplit(layout, path, index, delta, minSize);
    if (resized !== layout) set({ layout: resized });
  },

  setTabDrag(draggingTabId, dropTarget = null) {
    const current = get();
    if (current.draggingTabId === draggingTabId && sameDropTarget(current.dropTarget, dropTarget)) {
      return;
    }
    set({ draggingTabId, dropTarget });
  },

  applyState(id, state, message) {
    const current = get();
    const ended = state === "closed" || state === "error";
    set({
      tabs: patchTab(current.tabs, id, {
        state,
        message,
        // A command cannot remain in progress after its session ends; a
        // reconnect starts with a clean terminal activity state as well.
        ...(state === "connected"
          ? {}
          : { commandActivity: "idle" as const, activityKind: "command" as const }),
      }),
      ...(ended
        ? {
            pastePrompt: current.pastePrompt?.sessionId === id ? null : current.pastePrompt,
            clipboardPrompt:
              current.clipboardPrompt?.sessionId === id ? null : current.clipboardPrompt,
          }
        : {}),
    });
    // An ended session has nothing to type into; lock its terminal until a
    // reconnect brings it back.
    getController(id)?.setLocked(ended);
  },

  markCommandStarted(id, kind = "command") {
    set({
      tabs: patchTab(get().tabs, id, {
        commandActivity: "running",
        activityKind: kind,
      }),
    });
  },

  markCommandCompleted(id, kind = "command") {
    const state = get();
    set({
      tabs: patchTab(state.tabs, id, {
        // The active terminal already shows its returned prompt. Background
        // tabs retain a highlight until the user visits them.
        commandActivity: state.activeId === id ? "idle" : "complete",
        activityKind: kind,
      }),
    });
  },

  clearCommandActivity(id) {
    set({ tabs: patchTab(get().tabs, id, { commandActivity: "idle" }) });
  },

  setSize(id, cols, rows) {
    const { tabs, tabSizes } = get();
    // A resize that arrives after its session closed has no cell to record.
    if (!tabs.some((tab) => tab.info.id === id)) return;
    const previous = tabSizes[id];
    if (previous && previous.cols === cols && previous.rows === rows) return;
    set({ tabSizes: { ...tabSizes, [id]: { cols, rows } } });
  },
});
