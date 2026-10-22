import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
import { FilerPanel } from "../components/panels/FilerPanel";
import { useStore } from "../store";
import { IS_MAC } from "../platform";
import * as api from "../api";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  localHome: vi.fn(async () => "/selection-browser"),
  localList: vi.fn(async (path: string) => ({ path, entries: Array.from({ length: 1000 }, (_, index) => ({
    name: `file${index}.txt`, path: `${path}/file${index}.txt`, isDir: false, isSymlink: false,
    size: 10, modified: 1, permissions: null, owner: null, group: null,
  })) })),
  startFileDrag: vi.fn(async () => {}), localRemove: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initialState = useStore.getState();
const modifier = IS_MAC ? "Meta" : "Control";
const selected = () => [...document.querySelectorAll<HTMLElement>('.filer-entry[aria-selected="true"]')]
  .map((row) => row.querySelector(".row-label")!.textContent);
const row = (index: number) => document.querySelector<HTMLElement>(`[data-file-path="/selection-browser/file${index}.txt"] .filer-entry`)!;
const click = (index: number) => userEvent.click(page.getByText(`file${index}.txt`, { exact: true }));
async function add(index: number) {
  await userEvent.keyboard(`{${modifier}>}`);
  try { await click(index); } finally { await userEvent.keyboard(`{/${modifier}}`); }
}
async function open() {
  await page.viewport(900, 720);
  mount(h("div", { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } }, h(FilerPanel)));
  await expect.poll(() => row(0) !== null).toBe(true);
  await twoFrames();
}
async function scroll(end: boolean) {
  const list = document.querySelector<HTMLElement>(".filer-list")!;
  list.scrollTop = end ? list.scrollHeight : 0;
  await twoFrames();
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", tabs: [], activeId: null }, true);
  useStore.getState().setLanguage("en");
});
afterEach(async () => {
  await userEvent.keyboard(`{/${modifier}}{/Shift}`);
  await browserAfterEach();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  vi.restoreAllMocks();
});

it("selects, toggles, and right-clicks a group with real modifier input", async () => {
  await open();
  await click(0); await add(2);
  expect(selected()).toEqual(["file0.txt", "file2.txt"]);
  await userEvent.click(page.getByText("file0.txt", { exact: true }), { button: "right" });
  expect(selected()).toEqual(["file0.txt", "file2.txt"]);
  await userEvent.keyboard("{Escape}");
  await add(0);
  expect(selected()).toEqual(["file2.txt"]);
  await add(0);
  await page.screenshot({ path: "../../artifacts/performance/filer-selection/multiple.png" });
  await click(0);
  expect(selected()).toEqual(["file0.txt"]);
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
  expect(document.querySelector(".filer-footer")!.textContent).toContain("1000 selected");
  await userEvent.keyboard("{Escape}");
  expect(selected()).toEqual([]);
});

it("keeps selections across virtual row unmounts and selects a range through offscreen rows", async () => {
  await open();
  await click(0);
  await scroll(true);
  await expect.poll(() => row(999) !== null).toBe(true);
  await add(999);
  expect(document.querySelector(".filer-footer")!.textContent).toContain("2 selected");
  await scroll(false);
  await expect.poll(() => row(0)?.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelectorAll(".filer-entry").length).toBeLessThan(100);
  await click(0);
  await scroll(true);
  await expect.poll(() => row(999) !== null).toBe(true);
  await userEvent.keyboard("{Shift>}");
  try { await click(999); } finally { await userEvent.keyboard("{/Shift}"); }
  expect(document.querySelector(".filer-footer")!.textContent).toContain("1000 selected");
  expect(document.querySelectorAll(".filer-entry").length).toBeLessThan(100);
});

it("preserves a group during native drag and confirms every selected deletion", async () => {
  await open();
  await click(0); await add(2);
  const at = pagePoint(row(0));
  await mouse.press(at.x, at.y);
  await mouse.moveTo(at.x + 20, at.y);
  await mouse.release(at.x + 20, at.y);
  expect(api.startFileDrag).toHaveBeenCalledWith([
    "/selection-browser/file0.txt", "/selection-browser/file2.txt",
  ], expect.any(Function));
  expect(selected()).toEqual(["file0.txt", "file2.txt"]);
  await userEvent.click(page.getByRole("button", { name: "Delete", exact: true }));
  const dialog = page.getByRole("alertdialog");
  expect(dialog.element().textContent).toContain("2 selected items");
  await userEvent.click(dialog.getByRole("button", { name: "Delete", exact: true }));
  expect(vi.mocked(api.localRemove).mock.calls).toEqual([
    ["/selection-browser/file0.txt", false, false], ["/selection-browser/file2.txt", false, false],
  ]);
});
