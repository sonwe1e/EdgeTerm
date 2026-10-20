import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
vi.mock("./FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../actions", () => ({ revealCwdInFiler: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  onDragDropEvent: async () => () => {},
}) }));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  localHome: vi.fn(), localList: vi.fn(), localCreateFile: vi.fn(),
  startFileDrag: vi.fn(), onRemoteEditState: async () => () => {},
}));
import * as api from "../api";
import { FileBrowser } from "./FtpPane";
import { FilerPanel } from "./panels/FilerPanel";
import { VirtualFileRows, fileRowRange } from "./VirtualFileRows";
import type { FileEntry } from "../types";

let host: HTMLDivElement;
let root: Root;
let height = 290;
let prefix = 0;
/** Height of whatever the parent renders above the rows, in the mocked layout. */
let above = 0;
let observers: (() => void)[];
const entries: FileEntry[] = Array.from({ length: 10_000 }, (_, i) => ({
  path: `/test/file${i}`, name: `file${i}`, isDir: i % 10 === 0, isSymlink: false,
  size: i, modified: i, permissions: null, owner: null, group: null,
}));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); height = 290; prefix = 0; above = 0; observers = [];
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains("virtual-file-rows")
      ? above + prefix - this.parentElement!.scrollTop
      : 0;
    return { x: 0, y: top, top, bottom: top + height, height, width: 600, left: 0, right: 600, toJSON() {} };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const advance = () => act(() => { vi.advanceTimersByTime(16); });
function scroll(scroller: HTMLElement, top: number) {
  act(() => { scroller.scrollTop = top; scroller.dispatchEvent(new Event("scroll")); });
  advance();
}
function renderRows(list = entries, resetKey = "same", pitch = 29, message = false) {
  act(() => root.render(h("div", { className: "test-scroll" },
    message ? h("div", { className: "test-message" }, "Creating...") : null,
    h(VirtualFileRows<FileEntry>, { entries: list, rowHeight: pitch, resetKey,
      children: (e) => h("button", { "data-row": e.path }, e.name),
    }))));
}
/** The same render, awaited so MutationObserver records are delivered. */
const renderRowsAsync = async (
  list = entries, resetKey = "same", pitch = 29, message = false,
) => { await act(async () => { renderRows(list, resetKey, pitch, message); }); };

describe("virtual file rows", () => {
  it("bounds DOM at 10,000 entries, reaches the last row, and handles refresh shrink", () => {
    renderRows();
    expect(host.querySelectorAll("[data-row]")).toHaveLength(16);
    const scroller = host.firstElementChild as HTMLElement;
    scroll(scroller, 145000);
    expect(host.querySelectorAll("[data-row]")).toHaveLength(22);
    expect(host.textContent).toContain("file5000");
    scroll(scroller, 290000);
    expect(host.textContent).toContain("file9999");
    renderRows(entries.slice(0, 250));
    expect(host.textContent).toContain("file249");
    renderRows(entries.slice(0, 10));
    expect(host.querySelectorAll("[data-row]")).toHaveLength(10);
  });

  it("pins a captured source through scrolling until pointer capture is released", () => {
    renderRows();
    const row = host.querySelector("[data-row]")!;
    act(() => row.dispatchEvent(new Event("gotpointercapture", { bubbles: true })));
    scroll(host.firstElementChild as HTMLElement, 145000);
    expect(row.isConnected).toBe(true);
    expect(host.querySelectorAll("[data-row]")).toHaveLength(23);
    act(() => row.dispatchEvent(new Event("lostpointercapture", { bubbles: true })));
    expect(row.isConnected).toBe(false);
  });

  it("resets on navigation/sort and measures hidden panels, prefixes and font changes", () => {
    height = 0; renderRows();
    const scroller = host.firstElementChild as HTMLElement;
    height = 580; prefix = 60;
    act(() => observers.forEach((fn) => fn())); advance();
    expect(host.querySelectorAll("[data-row]").length).toBeGreaterThan(20);
    scroll(scroller, 6000);
    renderRows(entries, "same", 40);
    expect(host.querySelector<HTMLElement>(".virtual-file-rows")!.style.height).toBe("400000px");
    renderRows(entries, "new-directory", 40);
    expect(scroller.scrollTop).toBe(0);
    expect(host.textContent).toContain("file0");
  });

  it("skips the remeasure on a parent re-render, and keeps every real trigger", () => {
    const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    renderRows();
    const mounted = rect.mock.calls.length;
    expect(mounted).toBeGreaterThan(0);
    renderRows();
    expect(rect.mock.calls.length).toBe(mounted);
    renderRows(entries.slice(0, 500));
    const counted = rect.mock.calls.length;
    expect(counted).toBeGreaterThan(mounted);
    renderRows(entries.slice(0, 500), "same", 40);
    const pitched = rect.mock.calls.length;
    expect(pitched).toBeGreaterThan(counted);
    renderRows(entries.slice(0, 500), "next-directory", 40);
    expect(rect.mock.calls.length).toBeGreaterThan(pitched);
  });

  it("remeasures when content rendered above the rows appears and disappears", async () => {
    renderRows();
    const scroller = host.firstElementChild as HTMLElement;
    const firstRow = () => host.querySelector("[data-row]")!.getAttribute("data-row");
    scroll(scroller, 2900);
    expect(firstRow()).toBe("/test/file94");
    above = 40;
    await renderRowsAsync(entries, "same", 29, true);
    advance();
    expect(firstRow()).toBe("/test/file92");
    above = 0;
    await renderRowsAsync(entries, "same", 29, false);
    advance();
    expect(firstRow()).toBe("/test/file94");
  });

  it.each([8, 16, 40, 80])("coalesces scrolling at %i ms without losing the final range", (interval) => {
    renderRows();
    const scroller = host.firstElementChild as HTMLElement;
    act(() => {
      for (let i = 0; i < 100; i++) {
        scroller.scrollTop = i * 290;
        scroller.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(interval);
      }
      vi.advanceTimersByTime(16);
    });
    expect(host.textContent).toContain("file990");
    expect(host.querySelectorAll("[data-row]").length).toBeLessThanOrEqual(22);
  });

  it("does not leave a blank interval after a large listing shrinks", () => {
    expect(fileRowRange(250, 1e6, 290, 29)).toEqual({ start: 234, end: 250 });
    expect(fileRowRange(0, 1e6, 290, 29)).toEqual({ start: 0, end: 0 });
  });

  it("preserves real FTP selection, activation, sorting, row positions and drop metadata", () => {
    const select = vi.fn(); const activate = vi.fn(); const press = vi.fn();
    act(() => root.render(h(FileBrowser, {
      title: "Remote", subtitle: "SFTP", path: "/test", draft: "/test", entries,
      selected: "/test/file0", loading: false, error: null, side: "remote",
      draggingPath: null, dropHover: null, onItemPointerDown: press,
      onItemPointerMove() {}, onItemPointerUp() {}, onDragCancel() {},
      onDraftChange() {}, onOpenPath() {}, onHome() {}, onParent() {}, onRefresh() {},
      onSelect: select, onActivate: activate,
    })));
    const row = host.querySelector<HTMLElement>("[role=option]")!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("aria-setsize")).toBe("10000");
    expect(row.getAttribute("data-drop-dir")).toBe("/test/file0");
    act(() => {
      row.click(); row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(select).toHaveBeenCalledWith("/test/file0");
    expect(activate).toHaveBeenCalledWith(entries[0]);
    expect(press.mock.calls[0].slice(0, 2)).toEqual(["remote", entries[0]]);
    scroll(host.querySelector<HTMLElement>(".ftp-browser-list")!, 145000);
    expect(Number(host.querySelector("[role=option]")!.getAttribute("aria-posinset"))).toBeGreaterThan(4000);
    // By `data-sort-key`, not the caption's accessible name: an `aria-label`
    // there would replace the visible column name ("Name") with an instruction
    // ("Sort by name") for a screen reader, which is why the captions carry
    // the visible text as their name and this attribute as the stable handle.
    act(() => host.querySelector<HTMLButtonElement>('[data-sort-key="name"]')!.click());
    expect(host.querySelector<HTMLElement>(".ftp-browser-list")!.scrollTop).toBe(0);
    expect(host.querySelector("[role=option]")!.textContent).toContain("file9990");
    expect(host.querySelectorAll("[role=option]").length).toBeLessThanOrEqual(22);
  });

  it("preserves Filer selection, context menus, native drag and inline creation at depth", async () => {
    vi.mocked(api.localHome).mockResolvedValue("/test");
    vi.mocked(api.localList).mockResolvedValue({ path: "/test", entries });
    vi.mocked(api.localCreateFile).mockResolvedValue();
    vi.mocked(api.startFileDrag).mockResolvedValue();
    await act(async () => root.render(h(FilerPanel)));
    expect(host.querySelectorAll(".filer-entry").length).toBeLessThan(30);
    const scroller = host.querySelector<HTMLElement>(".filer-list")!;
    scroll(scroller, 100000);
    const row = host.querySelector<HTMLElement>(".filer-entry")!;
    const source = row.closest<HTMLElement>("[data-file-path]")!.dataset.filePath!;
    act(() => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(row.classList.contains("is-active")).toBe(true);
    act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(host.textContent).toContain("Copy Path");
    act(() => document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    row.setPointerCapture = () => {};
    row.hasPointerCapture = () => false;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }));
      row.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 20 }));
    });
    expect(api.startFileDrag).toHaveBeenCalledWith([source], expect.any(Function));
    act(() => host.querySelector<HTMLButtonElement>("[aria-label='New file']")!.click());
    const input = host.querySelector<HTMLInputElement>(".filer-new-entry input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "created.txt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.localCreateFile).toHaveBeenCalledWith("/test/created.txt");
    expect(host.querySelector(".filer-new-entry")).toBeNull();
    expect(host.querySelectorAll(".filer-entry").length).toBeLessThan(30);
  });
});
