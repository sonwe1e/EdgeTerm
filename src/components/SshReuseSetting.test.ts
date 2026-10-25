import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
import { SshReuseSetting } from "./SshReuseSetting";
import { useStore } from "../store";
it("persists reuse and refreshes mounted settings on import and reset", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useStore.getState().resetSettings();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(SshReuseSetting)));
    const input = () => host.querySelector<HTMLInputElement>("input")!;
    expect(input().checked).toBe(true);
    await act(async () => input().click());
    expect(useStore.getState().sshAutoReuse).toBe(false);
    expect(localStorage.getItem("edgeterm.sshAutoReuse")).toBe("off");
    expect(useStore.getState().exportSettings().sshAutoReuse).toBe(false);
    await act(async () => useStore.getState().applySettings({ sshAutoReuse: true }));
    expect(input().checked).toBe(true);
    await act(async () => useStore.getState().applySettings({ sshAutoReuse: "bad" }));
    expect(input().checked).toBe(true);
    await act(async () => input().click());
    await act(async () => useStore.getState().resetSettings());
    expect(input().checked).toBe(true);
    expect(localStorage.getItem("edgeterm.sshAutoReuse")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
