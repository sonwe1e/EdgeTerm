import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { ContextMenu } from "./ContextMenu";
import { MenuBar } from "./MenuBar";

// Only the native window boundary is replaced. Alt tracking, document
// capture/bubble ordering, menu focus and menu dismissal are production code.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => false,
    isMaximized: async () => false,
    onResized: async () => () => {},
    setTitle: async () => {},
  }),
}));

const initial = useStore.getState();
let host: HTMLDivElement;
let root: Root;
const noop = () => {};

function Fixture() {
  const [contextOpen, setContextOpen] = useState(false);
  return h(
    "div",
    null,
    h(MenuBar, {
      onNewSession: noop,
      onFind: noop,
      onFindNext: noop,
      onFontSettings: noop,
      onKeyboardShortcuts: noop,
      onCheckForUpdates: noop,
      onAbout: noop,
    }),
    h("textarea", {
      "aria-label": "Terminal input",
      onKeyDown: (event) => {
        // A terminal/application that already owns its function key.
        if (event.key === "F10") event.preventDefault();
      },
      onContextMenu: (event) => {
        event.preventDefault();
        setContextOpen(true);
      },
    }),
    h("button", { id: "outside" }, "Outside"),
    contextOpen &&
      h(ContextMenu, {
        x: 100,
        y: 100,
        items: [{ label: "Copy" }],
        onClose: () => setContextOpen(false),
      }),
  );
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useStore.setState({ ...initial, language: "en", tabs: [], activeId: null }, true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(Fixture)));
  act(() => host.querySelector("textarea")!.focus());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial, true);
  vi.clearAllTimers();
  vi.useRealTimers();
});

function key(type: "keydown" | "keyup", value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  act(() => {
    document.activeElement!.dispatchEvent(event);
    vi.advanceTimersByTime(20);
  });
  return event;
}

function plainAlt() {
  key("keydown", "Alt", { altKey: true });
  key("keyup", "Alt");
}

function openContext() {
  act(() => {
    host.querySelector("textarea")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }),
    );
  });
  act(() => vi.advanceTimersByTime(20));
  expect(document.activeElement?.closest(".context-menu")).not.toBeNull();
}

const menubarOpen = () =>
  host.querySelector("#menu-title-0")?.getAttribute("aria-expanded") === "true";

it.each(["Escape", "outside pointer"] as const)(
  "lets the first plain Alt open the menubar after context-menu Alt and %s dismissal",
  (dismiss) => {
    openContext();
    plainAlt();
    expect(host.querySelector(".context-menu")).not.toBeNull();
    expect(menubarOpen()).toBe(false);

    if (dismiss === "Escape") key("keydown", "Escape");
    else
      act(() => {
        const outside = host.querySelector<HTMLButtonElement>("#outside")!;
        outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        outside.focus();
      });
    expect(host.querySelector(".context-menu")).toBeNull();
    plainAlt();
    expect(menubarOpen()).toBe(true);
    expect(document.activeElement?.closest(".menubar .menu-dropdown")).not.toBeNull();
  },
);

it("keeps an Alt pointer gesture in the terminal and still accepts the next plain Alt", () => {
  key("keydown", "Alt", { altKey: true });
  act(() =>
    host
      .querySelector("textarea")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, altKey: true })),
  );
  key("keyup", "Alt");
  expect(menubarOpen()).toBe(false);
  plainAlt();
  expect(menubarOpen()).toBe(true);
});

it("clears an Alt hold begun outside but released inside the context menu", () => {
  key("keydown", "Alt", { altKey: true });
  openContext();
  key("keyup", "Alt");
  act(() => {
    const outside = host.querySelector<HTMLButtonElement>("#outside")!;
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    outside.focus();
  });
  expect(host.querySelector(".context-menu")).toBeNull();
  plainAlt();
  expect(menubarOpen()).toBe(true);
});

it("leaves F10 to an open context menu or an application that prevented it", () => {
  openContext();
  key("keydown", "F10");
  expect(menubarOpen()).toBe(false);
  expect(host.querySelector(".context-menu")).not.toBeNull();
  key("keydown", "Escape");
  const claimed = key("keydown", "F10");
  expect(claimed.defaultPrevented).toBe(true);
  expect(menubarOpen()).toBe(false);
});
