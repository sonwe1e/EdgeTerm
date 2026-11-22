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

  it("gives the list its focus back when an inline editor closes", async () => {
    await mount();
    const list = host.querySelector<HTMLElement>(".filer-list")!;
    const row = host.querySelector(".filer-entry")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
    expect(document.activeElement).toBe(input);

    // Escape closes the editor. Without the focus going back to the list, the
    // next arrow key landed on <body> and did nothing.
    await press(input, "Escape");
    expect(host.querySelector(".filer-new-entry")).toBeNull();
    expect(document.activeElement).toBe(list);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function submitNewFile(name: string) {
  await click(host.querySelector('[aria-label="New file"]')!);
  const input = host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
  type(input, name);
  await press(input, "Enter");
}

describe("Filer inline create completion", () => {
  it.each([false, true])(
    "does not retake the listing after newer breadcrumb navigation (create fails: %s)",
    async (fails) => {
      const create = deferred<void>();
      const navigate = deferred<Awaited<ReturnType<typeof api.localList>>>();
      vi.mocked(api.localHome).mockResolvedValueOnce("/ime/sub");
      vi.mocked(api.localCreateFile).mockReturnValueOnce(create.promise);
      vi.mocked(api.localList).mockImplementation(async (path) =>
        path === "/ime" ? navigate.promise : { path, entries: [entry] },
      );

      await mount();
      await submitNewFile("new.txt");
      expect(api.localCreateFile).toHaveBeenCalledExactlyOnceWith("/ime/sub/new.txt");
      await click(host.querySelector('.filer-crumb[title="/ime"]')!);
      expect(api.localList).toHaveBeenLastCalledWith("/ime");

      await act(async () => {
        if (fails) create.reject(new Error("obsolete create failure"));
        else create.resolve(undefined);
      });
      expect(api.localList).toHaveBeenCalledTimes(2);
      // The listing on screen is the folder the user moved to, so it must not
      // carry a failure about the one they left. A failure that no longer has a
      // folder to belong to is still a failure: it goes to the app-wide status
      // line, which stays until dismissed.
      expect(host.textContent).not.toContain("obsolete create failure");
      expect(useStore.getState().error).toBe(
        fails ? "Could not create new.txt: obsolete create failure" : null,
      );

      await act(async () => {
        navigate.resolve({ path: "/ime", entries: [] });
      });
      expect(host.querySelector('[aria-current="location"]')?.getAttribute("title")).toBe("/ime");
    },
  );

  it("refreshes the same folder again after a newer same-folder listing", async () => {
    const create = deferred<void>();
    vi.mocked(api.localCreateFile).mockReturnValueOnce(create.promise);
    vi.mocked(api.localList)
      .mockResolvedValueOnce({ path: "/ime", entries: [entry] })
      .mockResolvedValueOnce({ path: "/ime", entries: [entry] })
      .mockResolvedValueOnce({
        path: "/ime",
        entries: [entry, { ...entry, name: "new.txt", path: "/ime/new.txt" }],
      });

    await mount();
    await submitNewFile("new.txt");
    await click(host.querySelector('.filer-crumb[title="/ime"]')!);
    expect(api.localList).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("new.txt");

    await act(async () => create.resolve(undefined));
    expect(host.textContent).toContain("new.txt");
    expect(api.localList).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "still applies the create result in the same folder (fails: %s)",
    async (fails) => {
      const create = deferred<void>();
      vi.mocked(api.localCreateFile).mockReturnValueOnce(create.promise);
      vi.mocked(api.localList)
        .mockResolvedValueOnce({ path: "/ime", entries: [entry] })
        .mockResolvedValueOnce({
          path: "/ime",
          entries: [entry, { ...entry, name: "new.txt", path: "/ime/new.txt" }],
        });

      await mount();
      await submitNewFile("new.txt");
      expect(api.localCreateFile).toHaveBeenCalledExactlyOnceWith("/ime/new.txt");
      expect(api.localList).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (fails) create.reject(new Error("current create failure"));
        else create.resolve(undefined);
      });
      if (fails) {
        // In the folder the create belonged to, the failure goes next to that
        // folder's listing, as before, not to the app-wide status line.
        expect(host.textContent).toContain("current create failure");
        expect(useStore.getState().error).toBeNull();
        expect(api.localList).toHaveBeenCalledTimes(1);
      } else {
        expect(host.textContent).toContain("new.txt");
        expect(api.localList).toHaveBeenCalledTimes(2);
      }
    },
  );
});
