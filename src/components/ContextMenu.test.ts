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
  vi.useRealTimers();
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

it.each([1, 0.97])("reveals offscreen rows through a bordered menu's scale %s", (initialScale) => {
  const close = vi.fn();
  const menu = mount(close);
  const rows = [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")];
  let scale = initialScale;
  Object.defineProperty(menu, "clientTop", { configurable: true, value: 1 });
  Object.defineProperty(menu, "clientHeight", { configurable: true, value: 84 });
  Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 292 });
  vi.spyOn(menu, "getBoundingClientRect").mockImplementation(() =>
    DOMRect.fromRect({ x: 100, y: 100, width: 240 * scale, height: 86 * scale }),
  );
  rows.forEach((row, index) => {
    Object.defineProperty(row, "offsetParent", { configurable: true, value: menu });
    Object.defineProperty(row, "offsetTop", { configurable: true, value: 6 + index * 28 });
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: 28 });
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({
        x: 106,
        y: 100 + (7 + index * 28 - menu.scrollTop) * scale,
        width: 228 * scale,
        height: 28 * scale,
      }),
    );
  });
  act(() => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(rows[9]);
  // A key can arrive while menu-in is scaling the panel. After the animation
  // settles, the same focused row must remain wholly inside the scrollport.
  scale = 1;
  expect(menu.scrollTop).toBeGreaterThan(0);
  expect(rows[9].getBoundingClientRect().bottom).toBeLessThanOrEqual(
    menu.getBoundingClientRect().top + menu.clientTop + menu.clientHeight,
  );
  scale = initialScale;
  act(() => rows[9].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(rows[0]);
  scale = 1;
  expect(rows[0].getBoundingClientRect().top).toBeGreaterThanOrEqual(
    menu.getBoundingClientRect().top + menu.clientTop,
  );
  expect(close).not.toHaveBeenCalled();
});

it("reveals a submenu-parent row through its positioned wrapper when End selects it", () => {
  const close = vi.fn();
  act(() =>
    root.render(
      h(ContextMenu, {
        x: 100,
        y: 100,
        className: "tab-list-menu",
        items: [
          ...Array.from({ length: 9 }, (_, index) => ({ label: `Session ${index + 1}` })),
          { label: "More groups", children: [{ label: "Child" }] },
        ],
        onClose: close,
      }),
    ),
  );
  const menu = host.querySelector<HTMLElement>(".context-menu")!;
  const first = menu.querySelector<HTMLButtonElement>(":scope > button")!;
  const wrapper = menu.querySelector<HTMLElement>(":scope > .menu-submenu-entry")!;
  const last = wrapper.querySelector<HTMLButtonElement>(":scope > button")!;
  Object.defineProperties(menu, {
    clientHeight: { configurable: true, value: 84 },
    scrollHeight: { configurable: true, value: 310 },
  });
  Object.defineProperties(wrapper, {
    offsetParent: { configurable: true, value: menu },
    offsetTop: { configurable: true, value: 252 },
    clientTop: { configurable: true, value: 2 },
  });
  Object.defineProperties(last, {
    offsetParent: { configurable: true, value: wrapper },
    offsetTop: { configurable: true, value: 6 },
    offsetHeight: { configurable: true, value: 28 },
  });

  act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(last);
  // The wrapper's position and border both belong to this menu's layout:
  // (252 + 2 + 6 + 28) - 84 = 204 pixels needed to reveal the last row.
  expect(menu.scrollTop).toBe(204);
  expect(close).not.toHaveBeenCalled();
});

it("reveals a long submenu's Home and End rows without scrolling its parent or page", () => {
  vi.useFakeTimers();
  const close = vi.fn();
  act(() =>
    root.render(
      h(ContextMenu, {
        x: 100,
        y: 100,
        className: "tab-list-menu",
        items: [
          {
            label: "Groups",
            children: Array.from({ length: 10 }, (_, index) => ({ label: `Group ${index + 1}` })),
          },
        ],
        onClose: close,
      }),
    ),
  );
  const menu = host.querySelector<HTMLElement>(".context-menu")!;
  const opener = menu.querySelector<HTMLButtonElement>(".menu-submenu-entry > button")!;
  const child = menu.querySelector<HTMLElement>(".menu-submenu")!;
  const rows = [...child.querySelectorAll<HTMLButtonElement>(":scope > button")];
  Object.defineProperties(menu, {
    clientHeight: { configurable: true, value: 84 },
    scrollHeight: { configurable: true, value: 400 },
  });
  Object.defineProperties(child, {
    clientHeight: { configurable: true, value: 56 },
    scrollHeight: { configurable: true, value: 292 },
  });
  rows.forEach((row, index) => {
    Object.defineProperties(row, {
      offsetParent: { configurable: true, value: child },
      offsetTop: { configurable: true, value: 6 + index * 28 },
      offsetHeight: { configurable: true, value: 28 },
    });
  });
  menu.scrollTop = 37;
  const oldHtmlScroll = document.documentElement.scrollTop;
  const oldBodyScroll = document.body.scrollTop;
  document.documentElement.scrollTop = 91;
  document.body.scrollTop = 29;
  try {
    act(() => opener.click());
    act(() => vi.advanceTimersByTime(20));
    expect(document.activeElement).toBe(rows[0]);
    expect(opener.getAttribute("aria-expanded")).toBe("true");

    act(() => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(rows[9]);
    expect(child.scrollTop).toBe(230);
    expect(menu.scrollTop).toBe(37);
    expect(document.documentElement.scrollTop).toBe(91);
    expect(document.body.scrollTop).toBe(29);

    act(() => rows[9].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(rows[0]);
    expect(child.scrollTop).toBe(6);
    expect(menu.scrollTop).toBe(37);
    expect(document.documentElement.scrollTop).toBe(91);
    expect(document.body.scrollTop).toBe(29);
    expect(close).not.toHaveBeenCalled();
  } finally {
    document.documentElement.scrollTop = oldHtmlScroll;
    document.body.scrollTop = oldBodyScroll;
  }
});
