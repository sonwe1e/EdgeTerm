// A tab's own connection settings had no way into the profile library: the
// only save path was the Session panel's Edit dialog, which edits an already
// saved profile, so settings changed on an open tab died with it. The tab menu
// now offers Save Session, which stores them and relinks the tab without
// dialling another connection.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  saveProfile: vi.fn(),
  openSession: vi.fn(),
  defaultRecordingDir: vi.fn(async () => "/recordings"),
  listSerialPorts: vi.fn(async () => []),
}));

import { pendingSessionInfo } from "./actions";
import * as api from "./api";
import { useStore } from "./store";
import type { SessionProfile } from "./types";
import { SessionDialog } from "./components/SessionDialog";
import { TabStrip } from "./components/TabStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
const profile: SessionProfile = {
  id: "",
  name: "Temporary SSH",
  kind: "ssh",
  host: "server.example",
  username: "operator",
  auth: "password",
  password: "temporary-password",
  encoding: "gbk",
  backspace: "controlH",
};

let host: HTMLDivElement;
let root: Root;

const button = (text: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
const tabOf = (id: string) => useStore.getState().tabs.find((item) => item.info.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  useStore.setState({ ...initialState, language: "en", tabs: [], profiles: [], groups: [] }, true);
  useStore.getState().addTab(pendingSessionInfo("source", profile), profile);
  vi.mocked(api.saveProfile).mockImplementation(async (settings) => ({
    ...settings,
    id: settings.id || "saved-profile",
    password: null,
    passphrase: null,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("saving an open tab as a profile", () => {
  it("stores the settings and relinks the tab without dialling again", async () => {
    const saved = await useStore.getState().saveTabProfile("source", {
      ...profile,
      name: "Saved SSH",
      host: "saved.example",
    });
    expect(saved.id).toBe("saved-profile");
    expect(api.openSession).not.toHaveBeenCalled();
    const tab = tabOf("source");
    expect(tab.info.profileId).toBe("saved-profile");
    expect(tab.info.name).toBe("Saved SSH");
    expect(tab.profile.host).toBe("saved.example");
    expect(useStore.getState().profiles.map((item) => item.id)).toEqual(["saved-profile"]);
  });

  it("opens the dialog in Save Session mode, without a Connect action", async () => {
    const onClose = vi.fn();
    const tab = tabOf("source");
    await act(async () => {
      root.render(h(SessionDialog, { initial: tab.profile, saveSessionId: tab.info.id, onClose }));
    });
    expect(host.textContent).toContain("Save Session");
    expect(button("Connect")).toBeUndefined();
    expect(button("Save & connect")).toBeUndefined();

    await act(async () => {
      button("Save")!.click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(tabOf("source").info.profileId).toBe("saved-profile");
    expect(tabOf("source").info.name).toBe("Temporary SSH");
  });

  it("offers Save Session on the tab menu and hands over the tab's id", () => {
    const onSaveSession = vi.fn();
    act(() => {
      root.render(h(TabStrip, { paneId: useStore.getState().activePaneId, onSaveSession }));
    });
    const tab = host.querySelector<HTMLElement>('[data-tab-id="source"]')!;
    expect(tab).toBeTruthy();
    act(() => {
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 8, clientY: 8 }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent?.trim().startsWith("Save Session"),
    );
    expect(item).toBeTruthy();
    act(() => item!.click());
    expect(onSaveSession).toHaveBeenCalledWith("source");
  });
});
