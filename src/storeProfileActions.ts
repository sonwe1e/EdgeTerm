import type { StateCreator } from "zustand";
import * as api from "./api";
import { AppStore } from "./storeTypes";

export const createProfileActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "loadProfiles"
    | "upsertProfile"
    | "duplicateProfile"
    | "removeProfile"
    | "moveProfileToGroup"
    | "upsertGroup"
    | "removeGroup"
  >
> = (set, get) => ({
  async loadProfiles() {
    const [profiles, groups] = await Promise.all([api.listProfiles(), api.listSessionGroups()]);
    set({ profiles, groups });
  },

  async upsertProfile(profile) {
    const saved = await api.saveProfile(profile);
    const profiles = get().profiles;
    const index = profiles.findIndex((p) => p.id === saved.id);
    set({
      profiles:
        index === -1 ? [...profiles, saved] : profiles.map((p) => (p.id === saved.id ? saved : p)),
    });
    return saved;
  },

  async duplicateProfile(id) {
    const copy = await api.duplicateProfile(id);
    // The backend lists the copy right after the original; mirror that.
    const profiles = get().profiles.filter((p) => p.id !== copy.id);
    const index = profiles.findIndex((p) => p.id === id);
    profiles.splice(index === -1 ? profiles.length : index + 1, 0, copy);
    set({ profiles });
    return copy;
  },

  async removeProfile(id) {
    await api.deleteProfile(id);
    set({ profiles: get().profiles.filter((p) => p.id !== id) });
    // Sender commands scoped to the profile went with it.
    get().bumpSenderLibrary();
  },

  async moveProfileToGroup(id, groupId) {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile || (profile.groupId ?? null) === groupId) return;
    await get().upsertProfile({ ...profile, groupId });
  },

  async upsertGroup(group) {
    const saved = await api.saveSessionGroup(group);
    const groups = get().groups;
    const index = groups.findIndex((g) => g.id === saved.id);
    set({
      groups:
        index === -1 ? [...groups, saved] : groups.map((g) => (g.id === saved.id ? saved : g)),
    });
    return saved;
  },

  async removeGroup(id) {
    await api.deleteSessionGroup(id);
    await get().loadProfiles();
    // Sender commands scoped to the subtree moved up a level in the backend.
    get().bumpSenderLibrary();
  },
});
