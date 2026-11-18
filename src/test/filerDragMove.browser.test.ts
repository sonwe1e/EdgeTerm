import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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
        ? [entry(path, "inner.txt", false)]
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

it("hands the file to the system when the pointer leaves the panel", async () => {
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
  await mouse.press(from.x, from.y);
  await mouse.moveTo(from.x + 30, from.y);
  // Outside the panel: the gutters of the page, where another application (or
  // the desktop) would be.
  const panel = document.querySelector(".filer-panel")!.getBoundingClientRect();
  await mouse.moveTo(panel.left - 40, from.y);
  await mouse.release(panel.left - 40, from.y);
  await twoFrames();
  expect(vi.mocked(api.localRename).mock.calls.length).toBe(0);
  expect(vi.mocked(api.startFileDrag).mock.calls.length).toBe(1);
});

it("moves a file up a level when the pointer is dropped on the path bar", async () => {
  await page.viewport(900, 720);
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => Boolean(row("folder"))).toBe(true);
  await twoFrames();
  // Into the folder with a real double click, so the listing really changes.
  await userEvent.dblClick(page.getByText("folder", { exact: true }));
  await expect.poll(() => Boolean(row("inner.txt"))).toBe(true);
  await twoFrames();

  const parent = [...document.querySelectorAll<HTMLElement>(".filer-crumb")].find(
    (element) => element.dataset.dropFolder === "/drag",
  )!;
  expect(parent, "the path bar names the folder above").toBeTruthy();
  const from = pagePoint(row("inner.txt"));
  const onto = pagePoint(parent);
  // A hand crosses the panel's own chrome on the way up: past the rows, over the
  // title bar, then onto the crumb. A rule that hands the rows to the system at
  // the first non-row pixel loses them here.
  const panelRect = document.querySelector(".filer-panel")!.getBoundingClientRect();
  await mouse.press(from.x, from.y);
  await mouse.moveTo(from.x + 30, from.y);
  await mouse.moveTo(panelRect.left + 12, panelRect.top + 10);
  await twoFrames();
  expect(
    vi.mocked(api.startFileDrag).mock.calls.length,
    "the rows stay with the drag while the pointer is inside the panel",
  ).toBe(0);
  await mouse.moveTo(onto.x, onto.y);
  await mouse.release(onto.x, onto.y);

  await expect.poll(() => vi.mocked(api.localRename).mock.calls.length).toBe(1);
  expect(vi.mocked(api.localRename).mock.calls[0]).toEqual([
    "/drag/folder/inner.txt",
    "/drag/inner.txt",
  ]);
});
