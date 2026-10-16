import type { StateCreator } from "zustand";
import * as api from "./api";
import { t } from "./i18n";
import { adjacentPane, resizeSplit, splitPane as splitPaneInLayout } from "./layout";
import {
  acknowledgeTab,
  newPaneId,
  paneState,
  patchPane,
  patchTab,
  placeTab,
  sameDropTarget,
  sessionKey,
  settlePane,
} from "./storeLayout";
import { AppStore, Tab } from "./storeTypes";
import { disposeController, getController } from "./terminalRegistry";

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
    | "setClosePrompt"
    | "setActive"
    | "setActivePane"
    | "activateAdjacentTab"
    | "activateAdjacentPane"
    | "moveTab"
    | "moveTabToPane"
    | "splitPane"
    | "resizeLayout"
    | "setTabDrag"
    | "applyState"
    | "markCommandStarted"
    | "markCommandCompleted"
    | "clearCommandActivity"
    | "setSize"
  >
> = (set, get) => ({
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
      cols: 80,
      rows: 24,
      paneId: activePaneId,
    };
    set({
      tabs: [...tabs, tab],
      activeId: info.id,
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
    await api.closeSession(id).catch(() => undefined);
    // Files from this session opened in local editors stop syncing back.
    await api.stopRemoteEdits(id).catch(() => undefined);
    disposeController(id);
    // A challenge nobody will answer now would hold its half-open connection
    // until the backend's own timeout; release it here instead.
    for (const prompt of get().authPrompts) {
      if (prompt.sessionId === id) {
        void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
      }
    }
    const current = get();
    const closing = current.tabs.find((tab) => tab.info.id === id);
    const remaining = current.tabs.filter((tab) => tab.info.id !== id);
    // The pane shows its last tab next, or folds away with its last tab.
    const settled = closing
      ? settlePane({ ...paneState(current), tabs: remaining }, closing.paneId)
      : { ...paneState(current), tabs: remaining };
    const clearsSessionError = current.errorSessionId === id;
    const closePrompt = current.closePrompt?.filter((pending) => pending !== id) ?? null;
    set({
      ...settled,
      tabs: acknowledgeTab(settled.tabs, settled.activeId),
      status: clearsSessionError ? t("status.ready") : current.status,
      error: clearsSessionError ? null : current.error,
      errorSessionId: clearsSessionError ? null : current.errorSessionId,
      hostKeyPrompt: current.hostKeyPrompt?.sessionId === id ? null : current.hostKeyPrompt,
      pastePrompt: current.pastePrompt?.sessionId === id ? null : current.pastePrompt,
      clipboardPrompt: current.clipboardPrompt?.sessionId === id ? null : current.clipboardPrompt,
      authPrompts: current.authPrompts.filter((prompt) => prompt.sessionId !== id),
      closePrompt: closePrompt && closePrompt.length > 0 ? closePrompt : null,
    });
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

  setActive(id) {
    const { tabs, panes } = get();
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab) return;
    set({
      activeId: id,
      activePaneId: tab.paneId,
      panes: patchPane(panes, tab.paneId, { activeTabId: id }),
      // A completion is deliberately persistent on a background tab, but
      // selecting it is the acknowledgement. A still-running command keeps
      // its state so the particles return if the user switches away again.
      tabs: acknowledgeTab(tabs, id),
    });
  },

  setActivePane(paneId) {
    const { panes, activePaneId, tabs } = get();
    const pane = panes.find((item) => item.id === paneId);
    if (!pane || paneId === activePaneId) return;
    set({
      activePaneId: paneId,
      activeId: pane.activeTabId,
      tabs: acknowledgeTab(tabs, pane.activeTabId),
    });
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
    const to = Math.max(0, Math.min(index, strip.length - 1));
    if (to === from) return;
    set({ tabs: placeTab(tabs, id, tab.paneId, index) });
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
    const settled = settlePane(
      {
        tabs: placeTab(current.tabs, id, paneId, index),
        activeId: id,
        panes: patchPane(current.panes, paneId, { activeTabId: id }),
        layout: current.layout,
        activePaneId: paneId,
      },
      tab.paneId,
    );
    set({ ...settled, tabs: acknowledgeTab(settled.tabs, id) });
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
    const layout = splitPaneInLayout(current.layout, paneId, side, newId);
    const panes = [...current.panes, { id: newId, activeTabId: tab?.info.id ?? null }];
    if (!tab) {
      set({ layout, panes, activePaneId: newId, activeId: null });
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
    set({ ...settled, tabs: acknowledgeTab(settled.tabs, tab.info.id) });
    return newId;
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
    set({
      tabs: patchTab(get().tabs, id, {
        state,
        message,
        // A command cannot remain in progress after its session ends; a
        // reconnect starts with a clean terminal activity state as well.
        ...(state === "connected"
          ? {}
          : { commandActivity: "idle" as const, activityKind: "command" as const }),
      }),
    });
    // An ended session has nothing to type into; lock its terminal until a
    // reconnect brings it back.
    getController(id)?.setLocked(state === "closed" || state === "error");
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
    set({ tabs: patchTab(get().tabs, id, { cols, rows }) });
  },
});
