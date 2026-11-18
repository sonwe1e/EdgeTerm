import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../icons", () => ({ Icon: () => null }));
vi.mock("../../actions", () => ({ revealCwdInFiler: vi.fn() }));
// The local volume is case-insensitive here: that is the whole point.
vi.mock("../../platform", () => ({
  IS_MAC: false,
  IS_WINDOWS: true,
  HAS_TRAY: true,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  localHome: vi.fn(),
  localList: vi.fn(),
  localCreateFile: vi.fn(async () => {}),
  localRename: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));

import * as api from "../../api";
import { useStore } from "../../store";
import type { FileEntry } from "../../types";
import { FilerPanel } from "./FilerPanel";
import { lastPaths, listingCache } from "./filerDirectoryCache";

const initial = useStore.getState();
const entry = (name: string): FileEntry => ({
  name,
  path: `/ime/${name}`,
  isDir: false,
  isSymlink: false,
  size: 10,
  modified: 1,
  permissions: null,
  owner: null,
  group: null,
});
let host: HTMLDivElement;
let root: Root;

const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (input: HTMLInputElement, key: string) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });
const mount = () => act(async () => root.render(h(FilerPanel)));

/** Opens the rename editor on the row whose name is `name`. */
const startRename = async (name: string) => {
  const row = [...host.querySelectorAll(".filer-entry")].find((element) =>
    element.textContent?.includes(name),
  )!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    host
      .querySelector(".filer-list")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  return host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initial, language: "en", tabs: [], activeId: null }, true);
  lastPaths.clear();
  listingCache.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.localHome).mockResolvedValue("/ime");
  vi.mocked(api.localList).mockImplementation(async (path) => ({
    path,
    entries: [entry("a.txt"), entry("b.txt")],
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("renaming on a case-insensitive local volume", () => {
  it("refuses a name another file already has in a different case", async () => {
    await mount();
    const input = await startRename("b.txt");
    type(input, "A.TXT");
    await press(input, "Enter");
    // `a.txt` is the same file as `A.TXT` here, and the rename would replace
    // it without a word.
    expect(api.localRename).not.toHaveBeenCalled();
  });

  it("still lets a file change only its own case", async () => {
    await mount();
    const input = await startRename("b.txt");
    type(input, "B.TXT");
    await press(input, "Enter");
    expect(api.localRename).toHaveBeenCalledWith("/ime/b.txt", "/ime/B.TXT");
  });
});
