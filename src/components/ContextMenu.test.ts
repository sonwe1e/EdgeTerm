import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const mount = (onClose: () => void, nested = false) => {
  act(() =>
    root.render(
      h(ContextMenu, {
        x: 100,
        y: 100,
        className: "tab-list-menu",
        items: nested
          ? [{ label: "Groups", children: [{ label: "Last group" }] }]
          : Array.from({ length: 10 }, (_, index) => ({ label: `Session ${index + 1}` })),
        onClose,
      }),
    ),
  );
  return host.querySelector<HTMLElement>(".context-menu")!;
};

it("keeps a scroll inside the menu open but dismisses when the page behind it scrolls", () => {
  const close = vi.fn();
  const menu = mount(close);
  act(() => menu.dispatchEvent(new Event("scroll")));
  expect(close).not.toHaveBeenCalled();

  act(() => document.dispatchEvent(new Event("scroll")));
  expect(close).toHaveBeenCalledOnce();
});

it("also keeps a scroll inside a nested menu open", () => {
  const close = vi.fn();
  mount(close, true);
  act(() => host.querySelector(".menu-submenu")!.dispatchEvent(new Event("scroll")));
  expect(close).not.toHaveBeenCalled();
});

it("reveals offscreen rows when navigating a scrollable menu with End and Home", () => {
  const close = vi.fn();
  const menu = mount(close);
  const rows = [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")];
  Object.defineProperty(menu, "clientHeight", { configurable: true, value: 84 });
  Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 292 });
  vi.spyOn(menu, "getBoundingClientRect").mockImplementation(() =>
    DOMRect.fromRect({ x: 100, y: 100, width: 240, height: 84 }),
  );
  rows.forEach((row, index) =>
    vi
      .spyOn(row, "getBoundingClientRect")
      .mockImplementation(() =>
        DOMRect.fromRect({ x: 106, y: 106 + index * 28 - menu.scrollTop, width: 228, height: 28 }),
      ),
  );
  act(() => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(rows[9]);
  expect(menu.scrollTop).toBeGreaterThan(0);
  expect(rows[9].getBoundingClientRect().bottom).toBeLessThanOrEqual(
    menu.getBoundingClientRect().bottom,
  );
  act(() => rows[9].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(rows[0]);
  expect(rows[0].getBoundingClientRect().top).toBeGreaterThanOrEqual(
    menu.getBoundingClientRect().top,
  );
  expect(close).not.toHaveBeenCalled();
});
