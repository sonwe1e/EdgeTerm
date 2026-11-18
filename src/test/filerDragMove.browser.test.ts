import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import { FilerPanel } from "../components/panels/FilerPanel";
import { useStore } from "../store";
import * as api from "../api";
import "../styles.css";

// The jsdom tests drive the drop through a stubbed elementFromPoint, so the hit
// test — the part that decides whether a drag becomes a move at all — has never
// run against a real layout. Here the pointer is a real CDP pointer over real
// rows.
const entry = (path: string, name: string, isDir: boolean) => ({
  name,
  path: `${path}/${name}`,
  isDir,
  isSymlink: false,
  size: 10,
  modified: 1,
  permissions: null,
  owner: null,
  group: null,
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  localHome: vi.fn(async () => "/drag"),
  localList: vi.fn(async (path: string) => ({
    path,
    entries:
      path === "/drag/folder"
        ? []
        : [entry(path, "folder", true), entry(path, "a.txt", false), entry(path, "b.txt", false)],
  })),
  localRename: vi.fn(async () => {}),
  startFileDrag: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initialState = useStore.getState();
const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".filer-entry")].find(
    (element) => element.querySelector(".row-label")?.textContent === name,
  )!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", tabs: [], activeId: null }, true);
  useStore.getState().setLanguage("en");
});
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  vi.restoreAllMocks();
});

it("moves a file onto a folder row with a real pointer", async () => {
  await page.viewport(900, 720);
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => Boolean(row("a.txt"))).toBe(true);
  await twoFrames();

  const from = pagePoint(row("a.txt"));
  const onto = pagePoint(row("folder"));
  await mouse.press(from.x, from.y);
  // Past the drag threshold, then over the folder, as a hand would move.
  await mouse.moveTo(from.x + 30, from.y);
  await mouse.moveTo(onto.x, onto.y);
  await twoFrames();
  expect(row("folder").classList.contains("is-drop-target"), "the folder lights up").toBe(true);

  await mouse.release(onto.x, onto.y);
  await expect.poll(() => vi.mocked(api.localRename).mock.calls.length).toBe(1);
  expect(vi.mocked(api.localRename).mock.calls[0]).toEqual(["/drag/a.txt", "/drag/folder/a.txt"]);
});

it("hands the file to the system when the pointer leaves the rows", async () => {
  await page.viewport(900, 720);
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => Boolean(row("a.txt"))).toBe(true);
  await twoFrames();

  const from = pagePoint(row("a.txt"));
  const away = pagePoint(document.querySelector(".filer-footer")!);
  await mouse.press(from.x, from.y);
  await mouse.moveTo(away.x, away.y);
  await mouse.release(away.x, away.y);
  await twoFrames();
  expect(vi.mocked(api.localRename).mock.calls.length).toBe(0);
  expect(vi.mocked(api.startFileDrag).mock.calls.length).toBe(1);
});
