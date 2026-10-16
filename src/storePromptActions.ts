import type { StateCreator } from "zustand";
import { AppStore } from "./storeTypes";

export const createPromptActions: StateCreator<
  AppStore,
  [],
  [],
  Pick<
    AppStore,
    | "bumpSenderLibrary"
    | "setStatus"
    | "setError"
    | "addAuthPrompt"
    | "clearAuthPrompt"
    | "setHostKeyPrompt"
    | "setSshConfigImport"
    | "revealInFiler"
  >
> = (set, get) => ({
  bumpSenderLibrary() {
    set({ senderLibraryVersion: get().senderLibraryVersion + 1 });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error, sessionId) {
    set({ error, errorSessionId: error ? (sessionId ?? null) : null });
  },

  addAuthPrompt(prompt) {
    set({ authPrompts: [...get().authPrompts, prompt] });
  },

  clearAuthPrompt(id) {
    set({
      authPrompts: get().authPrompts.filter((prompt) => prompt.id !== id),
    });
  },

  setHostKeyPrompt(prompt) {
    set({ hostKeyPrompt: prompt });
  },

  setSshConfigImport(preview) {
    set({ sshConfigImport: preview });
  },

  revealInFiler(sessionId, path) {
    const token = (get().filerTarget?.token ?? 0) + 1;
    set({ filerTarget: { sessionId, path, token } });
    if (!get().panels.filer) get().togglePanel("filer");
  },
});
