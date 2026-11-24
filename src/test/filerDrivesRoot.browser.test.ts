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
        ? [entry(path, "inner.txt", false)]
        : path === "/drag/keys"
          ? [entry(path, "A.TXT", false)]
          : [
              entry(path, "folder", true),
              entry(path, "keys", true),
              entry(path, "a.txt", false),
              entry(path, "b.txt", false),
            ],
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

/**
 * "This PC" is a virtual listing whose rows are whole drives. Dropping one
 * onto another would ask the backend to rename an entire volume into a folder
 * on the other drive, which is not a move.
 *
 * It lives in its own file because reaching the drives root needs a different
 * listing fixture, and a per-test override of the shared one leaks into every
 * case after it.
 *
 * Boundary: Chromium over a controlled IPC stub, a real pointer.
 */
it("moves nothing when a drive is dropped onto another drive", async () => {
  await page.viewport(900, 720);
  vi.mocked(api.localHome).mockResolvedValue(api.LOCAL_DRIVES_ROOT);
  vi.mocked(api.localList).mockImplementation(async (path: string) => ({
    path,
    entries:
      path === api.LOCAL_DRIVES_ROOT ? [entry(path, "C:", true), entry(path, "D:", true)] : [],
  }));
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => Boolean(row("C:"))).toBe(true);
  await twoFrames();

  const before = useStore.getState().status;
  const from = pagePoint(row("C:"));
  const onto = pagePoint(row("D:"));
  await mouse.press(from.x, from.y);
  await mouse.moveTo(from.x + 30, from.y);
  await mouse.moveTo(onto.x, onto.y);
  await twoFrames();
  await mouse.release(onto.x, onto.y);
  await twoFrames();

  // No assertion that the target row lit up: the drives root refuses the whole
  // gesture upstream of the move, so it never becomes a drop target. What this
  // pins is the outcome - no rename of a volume, no error line, nothing said.
  expect(vi.mocked(api.localRename)).not.toHaveBeenCalled();
  expect(vi.mocked(api.startFileDrag)).not.toHaveBeenCalled();
  expect(document.querySelector('.filer-panel [role="alert"]')).toBeNull();
  expect(useStore.getState().status, "a no-op says nothing").toBe(before);
});
