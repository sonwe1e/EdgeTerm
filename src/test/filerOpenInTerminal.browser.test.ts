import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { pendingSessionInfo } from "../actions";
import { FilerPanel } from "../components/panels/FilerPanel";
import { useStore, type Tab } from "../store";
import type { SessionProfile } from "../types";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import * as api from "../api";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  localHome: vi.fn(async () => "/root"),
  localList: vi.fn(async (path: string) => ({
    path,
    entries: [
      {
        name: "app.log",
        path: `${path}/app.log`,
        isDir: false,
        isSymlink: false,
        size: 12,
        modified: 1,
        permissions: null,
        owner: null,
        group: null,
      },
    ],
  })),
  writeSession: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initialState = useStore.getState();

const shell = (state: Tab["state"]): Tab => ({
  info: pendingSessionInfo("t1", { id: "t1", name: "Local", kind: "local" } as SessionProfile),
  profile: { id: "t1", name: "Local", kind: "local" } as SessionProfile,
  number: 1,
  ordinal: 0,
  state,
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

async function openMenu() {
  await page.viewport(900, 720);
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => document.querySelector(".filer-entry") !== null).toBe(true);
  await twoFrames();
  const more = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  expect(more, "the view menu is on the bar").not.toBeNull();
  await userEvent.click(more);
  await twoFrames();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useStore.getState().setLanguage("en");
});

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
});

it("walks the shell to the folder on screen", async () => {
  useStore.setState({ ...initialState, tabs: [shell("connected")], activeId: "t1" });
  useStore.getState().setLanguage("en");
  await openMenu();
  await userEvent.click(page.getByRole("menuitem", { name: "Open in Terminal", exact: true }));
  await twoFrames();
  expect(api.writeSession).toHaveBeenCalledWith("t1", "cd '/root'\r");
});

it("does not offer it when that shell is not the one on screen", async () => {
  useStore.setState({ ...initialState, tabs: [shell("connected")], activeId: null });
  useStore.getState().setLanguage("en");
  await openMenu();
  const entry = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === "Open in Terminal",
  );
  expect(entry, "the entry is listed even when it cannot act").toBeTruthy();
  expect(entry!.disabled, "no shell of its own to walk").toBe(true);
  expect(api.writeSession).not.toHaveBeenCalled();
});
