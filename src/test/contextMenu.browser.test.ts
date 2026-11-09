import { createElement as h, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { MenuBar } from "../components/MenuBar";
import { useStore } from "../store";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => false,
    isMaximized: async () => false,
    onResized: async () => () => {},
    setTitle: async () => {},
  }),
}));

const initial = useStore.getState();
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
});

function Fixture({
  items,
  input,
  menuClass,
  withMenuBar,
}: {
  items: MenuItem[];
  input: (key: string) => void;
  menuClass?: string;
  withMenuBar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return h(
    "div",
    null,
    withMenuBar &&
      h(MenuBar, {
        onNewSession() {},
        onFind() {},
        onFindNext() {},
        onFontSettings() {},
        onKeyboardShortcuts() {},
        onCheckForUpdates() {},
        onAbout() {},
      }),
    h("textarea", {
      "aria-label": "Terminal input",
      onKeyDown: (event) => input(event.key),
      onContextMenu: (event) => {
        event.preventDefault();
        setOpen(true);
      },
    }),
    h("button", { id: "outside" }, "Outside"),
    open &&
      h(ContextMenu, {
        x: 100,
        y: 100,
        items,
        className: menuClass,
        onClose: () => setOpen(false),
      }),
  );
}

async function open(items: MenuItem[], menuClass?: string, withMenuBar = false) {
  const input = vi.fn();
  mount(h(Fixture, { items, input, menuClass, withMenuBar }));
  const terminal = document.querySelector("textarea")!;
  terminal.focus();
  await userEvent.click(terminal, { button: "right" });
  await twoFrames();
  return { terminal, input };
}

it("owns navigation and Enter while open, without delivering input to the terminal", async () => {
  const action = vi.fn();
  const { terminal, input } = await open([
    { label: "First" },
    { label: "Unavailable", disabled: true },
    { label: "Run", action },
  ]);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(input).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);
});

it("navigates nested submenus and returns to their parents, then dismisses with Escape", async () => {
  const action = vi.fn();
  const { terminal, input } = await open([
    { label: "Move", children: [{ label: "Nested", children: [{ label: "Target", action }] }] },
  ]);
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Nested");
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Target");
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement?.textContent).toBe("Nested");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(terminal);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(input).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});

it("paints and hit-tests a second-level submenu inside a roomy viewport", async () => {
  await page.viewport(1400, 900);
  const action = vi.fn();
  const { input } = await open([
    {
      label: "Move",
      children: [{ label: "Nested", children: [{ label: "Visible target", action }] }],
    },
  ]);
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  const menu = document.querySelector<HTMLElement>(".context-menu")!;
  const parent = menu.querySelector<HTMLElement>('[data-submenu-key="0"] > .menu-submenu')!;
  const child = parent.querySelector<HTMLElement>('[data-submenu-key="0.0"] > .menu-submenu')!;
  const target = child.querySelector<HTMLButtonElement>(":scope > button")!;
  expect(document.activeElement).toBe(target);
  // Wait only for the real entrance animation; no scrollIntoView or click
  // auto-scrolling may rescue a submenu clipped by its parent's scrollport.
  await expect
    .poll(() =>
      menu
        .getAnimations({ subtree: true })
        .every((animation) => animation.playState === "finished" || animation.playState === "idle"),
    )
    .toBe(true);
  const rect = target.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(40);
  expect(rect.height).toBeGreaterThan(10);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThan(window.innerWidth);
  expect(rect.bottom).toBeLessThan(window.innerHeight);
  const parentStyle = getComputedStyle(parent);
  for (const fraction of [0.1, 0.5, 0.9]) {
    const hit = document.elementFromPoint(
      rect.left + rect.width * fraction,
      rect.top + rect.height / 2,
    );
    expect(
      target.contains(hit),
      `target hit at ${fraction}: ${hit?.tagName}.${hit?.className}; ` +
        `parent overflow=${parentStyle.overflowX}/${parentStyle.overflowY}`,
    ).toBe(true);
  }
  // Raw pointer coordinates do not ask Playwright to reveal a hidden target.
  const point = pagePoint(target, 0.5, 0.5);
  await mouse.moveTo(point.x, point.y);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  expect(action).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
  expect(document.querySelector(".context-menu")).toBeNull();
});

it("keeps pointer actions working and lets an outside click take focus", async () => {
  const action = vi.fn();
  await open([{ label: "Run", action }]);
  await userEvent.click(document.querySelector(".context-menu button")!);
  expect(action).toHaveBeenCalledTimes(1);
  await userEvent.click(document.querySelector("textarea")!, { button: "right" });
  await userEvent.click(document.querySelector("#outside")!);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement?.id).toBe("outside");
});

it("keeps a tall sessions menu open while scrolling and reveals keyboard focus", async () => {
  await page.viewport(900, 560);
  await open(
    Array.from({ length: 40 }, (_, index) => ({ label: `Session ${index + 1}` })),
    "tab-list-menu",
  );
  const menu = document.querySelector<HTMLElement>(".context-menu")!;
  expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
  menu.scrollTop = 100;
  await twoFrames();
  expect(document.querySelector(".context-menu")).toBe(menu);

  await userEvent.keyboard("{End}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Session 40");
  const last = document.activeElement as HTMLElement;
  expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    menu.getBoundingClientRect().bottom,
  );
  await userEvent.keyboard("{Home}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Session 1");
  expect(document.activeElement!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    menu.getBoundingClientRect().top,
  );
  expect(document.querySelector(".context-menu")).toBe(menu);
});

it("does not leave a stale Alt hold in the real menubar after a context menu closes", async () => {
  await page.viewport(1100, 720);
  useStore.setState({ language: "en" });
  const { terminal } = await open([{ label: "Copy" }], undefined, true);
  await userEvent.keyboard("{Alt}");
  expect(document.querySelector(".context-menu")).not.toBeNull();
  expect(document.querySelector(".menubar .menu-dropdown")).toBeNull();
  await userEvent.keyboard("{Escape}");
  await twoFrames();
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);

  await userEvent.keyboard("{Alt}");
  await twoFrames();
  expect(document.querySelector("#menu-title-0")?.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.closest(".menubar .menu-dropdown")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
});

it("resets Alt released inside a context menu after its press started in the terminal", async () => {
  await page.viewport(1100, 720);
  useStore.setState({ language: "en" });
  mount(h(Fixture, { items: [{ label: "Copy" }], input: vi.fn(), withMenuBar: true }));
  const terminal = document.querySelector("textarea")!;
  terminal.focus();
  await userEvent.keyboard("{Alt>}");
  await userEvent.click(terminal, { button: "right" });
  await twoFrames();
  expect(document.activeElement?.closest(".context-menu")).not.toBeNull();
  await userEvent.keyboard("{/Alt}");
  expect(document.querySelector(".menubar .menu-dropdown")).toBeNull();
  await userEvent.click(document.querySelector("#outside")!);
  expect(document.querySelector(".context-menu")).toBeNull();

  await userEvent.keyboard("{Alt}");
  await twoFrames();
  expect(document.querySelector("#menu-title-0")?.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
});
