import type { StateCreator } from "zustand";

import { broadcastTargets } from "./broadcast";
import { t } from "./i18n";
import type { AppStore } from "./storeTypes";

/**
 * Synchronized input is a live mode with a blast radius, so the guard lives in
 * the store rather than in each caller: it cannot be switched on when no other
 * connected shell would receive the bytes, and switching it on or off always
 * reports what happened in the status bar. It is deliberately not persisted —
 * a destructive mode must never be re-armed behind the reader's back on the
 * next start.
 */
export const createBroadcastActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "broadcastInput"
    | "setBroadcastInput"
    | "broadcastExcluded"
    | "setBroadcastPeer"
    | "broadcastExcludedGroups"
    | "setBroadcastGroup"
  >
> = (set, get) => ({
  broadcastInput: false,
  broadcastExcluded: [],
  broadcastExcludedGroups: [],
  setBroadcastInput(on) {
    const state = get();
    if (on === state.broadcastInput) return;
    if (!on) {
      set({ broadcastInput: false, status: t("broadcast.off") });
      return;
    }
    const targets = broadcastTargets(
      state.tabs,
      state.activeId,
      state.broadcastExcluded,
      state.broadcastExcludedGroups,
    );
    if (targets.length === 0) {
      set({ status: t("broadcast.needsSecondSession") });
      return;
    }
    set({
      broadcastInput: true,
      broadcastExcluded: state.broadcastExcluded,
      status: t("broadcast.on", { count: targets.length }),
    });
  },
  /**
   * Checks or unchecks one target while synchronized input is on. The mode
   * turns itself off when the last included shell is unchecked: staying on
   * with no recipients would look live and write nothing.
   */
  setBroadcastPeer(id, included) {
    const state = get();
    const excluded = state.broadcastExcluded.filter((peer) => peer !== id);
    if (!included) excluded.push(id);
    const targets = broadcastTargets(
      state.tabs,
      state.activeId,
      excluded,
      state.broadcastExcludedGroups,
    );
    if (state.broadcastInput && targets.length === 0 && !included) {
      set({ broadcastExcluded: excluded, broadcastInput: false, status: t("broadcast.off") });
      return;
    }
    set({
      broadcastExcluded: excluded,
      status: state.broadcastInput ? t("broadcast.on", { count: targets.length }) : state.status,
    });
  },
  /**
   * Includes or leaves out a whole group. Members that were individually
   * unchecked stay unchecked: the two lists compose, they do not replace each
   * other. Turning everything off still turns the mode off.
   */
  setBroadcastGroup(groupId, included) {
    const state = get();
    const groups = state.broadcastExcludedGroups.filter((id) => id !== groupId);
    if (!included) groups.push(groupId);
    const targets = broadcastTargets(state.tabs, state.activeId, state.broadcastExcluded, groups);
    if (state.broadcastInput && targets.length === 0 && !included) {
      set({ broadcastExcludedGroups: groups, broadcastInput: false, status: t("broadcast.off") });
      return;
    }
    set({
      broadcastExcludedGroups: groups,
      status: state.broadcastInput ? t("broadcast.on", { count: targets.length }) : state.status,
    });
  },
});
