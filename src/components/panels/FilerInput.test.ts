import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../icons", () => ({ Icon: () => null }));
vi.mock("../../actions", () => ({ revealCwdInFiler: vi.fn() }));
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
const entry: FileEntry = {
  name: "original.txt",
  path: "/ime/original.txt",
  isDir: false,
  isSymlink: false,
  size: 10,
  modified: 1,
  permissions: null,
  owner: null,
  group: null,
};
let host: HTMLDivElement;
let root: Root;
const press = (input: HTMLInputElement, key: string, isComposing = false) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, isComposing }));
  });
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = (element: Element) => act(async () => (element as HTMLElement).click());
const mount = () => act(async () => root.render(h(FilerPanel)));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initial, language: "en", tabs: [], activeId: null }, true);
  lastPaths.clear();
  listingCache.clear();
  vi.mocked(api.localHome).mockResolvedValue("/ime");
  vi.mocked(api.localList).mockImplementation(async (path) => ({ path, entries: [entry] }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial, true);
  vi.restoreAllMocks();
});

describe.each(["Enter", "Escape"])("Filer keeps IME %s inside the input method", (key) => {
  it("does not navigate or close the path editor until composition ends", async () => {
    await mount();
    await act(async () =>
      host
        .querySelector(".filer-crumbs")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = host.querySelector<HTMLInputElement>(".filer-path-edit")!;
    type(input, "/ime/中文");
    await press(input, key, true);
    expect(host.querySelector(".filer-path-edit")).toBe(input);
    expect(api.localList).not.toHaveBeenCalledWith("/ime/中文");
    await press(input, "Enter");
    expect(api.localList).toHaveBeenCalledWith("/ime/中文");
  });

  it("does not create or discard a file name while composing", async () => {
    await mount();
    await click(host.querySelector('[aria-label="New file"]')!);
    const input = host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
    type(input, "中文.txt");
    await press(input, key, true);
    expect(host.querySelector(".filer-new-entry input")).toBe(input);
    expect(api.localCreateFile).not.toHaveBeenCalled();
    await press(input, "Enter");
    expect(api.localCreateFile).toHaveBeenCalledWith("/ime/中文.txt");
  });

  it("does not rename or discard a draft while composing", async () => {
    await mount();
    const row = host.querySelector(".filer-entry")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      host
        .querySelector(".filer-list")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
    type(input, "中文.txt");
    await press(input, key, true);
    expect(host.querySelector(".filer-new-entry input")).toBe(input);
    expect(api.localRename).not.toHaveBeenCalled();
    await press(input, "Enter");
    expect(api.localRename).toHaveBeenCalledWith("/ime/original.txt", "/ime/中文.txt");
  });
});
