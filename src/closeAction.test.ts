import { beforeEach, describe, expect, it } from "vitest";

import { HAS_TRAY } from "./platform";
import { useStore } from "./store";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ closeAction: "ask" });
});

describe("closeAction", () => {
  it("persists a picked action and carries it through export", () => {
    useStore.getState().setCloseAction("tray");
    const stored = HAS_TRAY ? "tray" : "ask";
    expect(useStore.getState().closeAction).toBe(stored);
    expect(localStorage.getItem("edgeterm.closeAction")).toBe(stored);
    expect(useStore.getState().exportSettings().closeAction).toBe(stored);
  });

  it("degrades a stored tray to ask where the platform has no tray", () => {
    if (HAS_TRAY) return; // The degradation is Linux-only; skip elsewhere.
    localStorage.setItem("edgeterm.closeAction", "tray");
    useStore.setState({ closeAction: "tray" });
    // Reloading is the loadCloseAction path; the setter mirrors it too.
    useStore.getState().setCloseAction("tray");
    expect(useStore.getState().closeAction).toBe("ask");
  });

  it("ignores an unknown imported action", () => {
    useStore.getState().applySettings({ closeAction: "boss" });
    expect(useStore.getState().closeAction).toBe("ask");
  });

  it("keeps a valid imported action", () => {
    if (!HAS_TRAY) return;
    useStore.getState().applySettings({ closeAction: "exit" });
    expect(useStore.getState().closeAction).toBe("exit");
  });

  it("resets to ask", () => {
    if (!HAS_TRAY) return;
    useStore.getState().setCloseAction("exit");
    useStore.getState().resetSettings();
    expect(useStore.getState().closeAction).toBe("ask");
    expect(localStorage.getItem("edgeterm.closeAction")).toBeNull();
  });
});
