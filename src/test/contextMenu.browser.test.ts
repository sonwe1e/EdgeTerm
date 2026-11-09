import { createElement as h, useState, type CSSProperties } from "react";
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
  position,
}: {
  items: MenuItem[];
  input: (key: string) => void;
  menuClass?: string;
  withMenuBar?: boolean;
  position?: { x: number; y: number };
}) {
  const [open, setOpen] = useState(false);
  return h(
    "div",
    { className: "app", style: { "--panel-font-size": "14px" } as CSSProperties },
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
        x: position?.x ?? 100,
        y: position?.y ?? 100,
        items,
        className: menuClass,
        onClose: () => setOpen(false),
      }),
  );
}

async function open(
  items: MenuItem[],
  menuClass?: string,
  withMenuBar = false,
  position?: { x: number; y: number },
) {
  const input = vi.fn();
  mount(h(Fixture, { items, input, menuClass, withMenuBar, position }));
  const terminal = document.querySelector("textarea")!;
  terminal.focus();
  await userEvent.click(terminal, { button: "right" });
  await twoFrames();
  return { terminal, input };
}

function childOf(trigger: HTMLElement) {
  const id = trigger.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const child = document.getElementById(id!);
  expect(child).not.toBeNull();
  return child!;
}

async function menusSettled() {
  // Portals have separate DOM subtrees, but every level must have finished
  // its real entrance animation before checking settled paint/hit geometry.
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>(".context-menu")].every((menu) =>
        menu
          .getAnimations({ subtree: true })
          .every(
            (animation) => animation.playState === "finished" || animation.playState === "idle",
          ),
      ),
    )
    .toBe(true);
  await twoFrames();
}

function expectPainted(target: HTMLElement, parent?: HTMLElement) {
  const rect = target.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(40);
  expect(rect.height).toBeGreaterThan(10);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThan(window.innerWidth);
  expect(rect.bottom).toBeLessThan(window.innerHeight);
  const parentStyle = parent && getComputedStyle(parent);
  for (const fraction of [0.1, 0.5, 0.9]) {
    const hit = document.elementFromPoint(
      rect.left + rect.width * fraction,
      rect.top + rect.height / 2,
    );
    expect(
      target.contains(hit),
      `target hit at ${fraction}: ${hit?.tagName}.${hit?.className}; ` +
        `parent overflow=${parentStyle?.overflowX}/${parentStyle?.overflowY}`,
    ).toBe(true);
  }
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
  const { terminal, input } = await open([
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
  const parent = childOf(menu.querySelector<HTMLElement>(":scope > .menu-submenu-entry > button")!);
  const child = childOf(
    parent.querySelector<HTMLElement>(":scope > .menu-submenu-entry > button")!,
  );
  const target = child.querySelector<HTMLButtonElement>(":scope > button")!;
  expect(document.activeElement).toBe(target);
  // Wait only for the real entrance animation; no scrollIntoView or click
  // auto-scrolling may rescue a submenu clipped by its parent's scrollport.
  await menusSettled();
  expectPainted(target, parent);
  expect(child.closest(".app")).toBe(menu.closest(".app"));
  expect(getComputedStyle(target).fontSize).toBe("14px");
  expect(getComputedStyle(target).fontFamily).toBe(getComputedStyle(menu).fontFamily);
  await page.screenshot({
    path: "./__screenshots__/contextMenu.browser.test.ts/deep-submenu-1400.png",
  });
  // Raw pointer coordinates do not ask Playwright to reveal a hidden target.
  const point = pagePoint(target, 0.5, 0.5);
  await mouse.moveTo(point.x, point.y);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  expect(action).toHaveBeenCalledOnce();
  expect(input).not.toHaveBeenCalled();
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);
});

it("opens deep menus leftwards at the 900px edge and reaches a long submenu's last row", async () => {
  await page.viewport(900, 560);
  const { terminal, input } = await open(
    [
      {
        label: "Move",
        children: [
          {
            label: "Nested",
            children: Array.from({ length: 45 }, (_, index) => ({ label: `Target ${index + 1}` })),
          },
        ],
      },
    ],
    undefined,
    false,
    { x: 890, y: 550 },
  );
  const trigger = document.activeElement as HTMLElement;
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  const nested = document.activeElement as HTMLElement;
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  const parent = childOf(trigger);
  const child = childOf(nested);
  await menusSettled();
  expect(parent.getBoundingClientRect().right).toBeLessThan(trigger.getBoundingClientRect().left);
  expect(child.getBoundingClientRect().right).toBeLessThan(nested.getBoundingClientRect().left);
  expect(child.scrollHeight).toBeGreaterThan(child.clientHeight);
  await userEvent.keyboard("{End}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Target 45");
  expectPainted(document.activeElement as HTMLElement, parent);
  await page.screenshot({
    path: "./__screenshots__/contextMenu.browser.test.ts/edge-long-submenu-end-900.png",
  });
  await userEvent.keyboard("{Home}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Target 1");
  expectPainted(document.activeElement as HTMLElement, parent);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(nested);
  expect(child.isConnected).toBe(false);
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);
  expect(input).not.toHaveBeenCalled();
});

it("keeps a long 18px portal stable and hit-testable where menu levels overlap", async () => {
  await page.viewport(900, 560);
  const action = vi.fn();
  await open(
    [
      {
        label: "Move",
        children: [
          {
            label: "Nested",
            children: [
              {
                label: "Destination with a long readable project name and another server workspace",
                action,
              },
            ],
          },
        ],
      },
    ],
    undefined,
    false,
    { x: 890, y: 300 },
  );
  document.querySelector<HTMLElement>(".app")!.style.setProperty("--panel-font-size", "18px");
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  const nested = document.activeElement as HTMLElement;
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  const child = childOf(nested);
  const target = child.querySelector<HTMLElement>(":scope > button")!;
  await menusSettled();
  expect(getComputedStyle(target).fontSize).toBe("18px");
  expectPainted(target);
  const before = child.getBoundingClientRect();
  await twoFrames();
  await twoFrames();
  const after = child.getBoundingClientRect();
  expect(after.left).toBeCloseTo(before.left, 1);
  expect(after.width).toBeCloseTo(before.width, 1);
  expect(
    document
      .elementsFromPoint(after.left + after.width / 2, after.top + after.height / 2)
      .find((element) => element.matches(".context-menu")),
  ).toBe(child);
  await page.screenshot({
    path: "./__screenshots__/contextMenu.browser.test.ts/long-label-submenu-18px-900.png",
  });
  const point = pagePoint(target);
  await mouse.moveTo(point.x, point.y);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  expect(action).toHaveBeenCalledOnce();
});

it("preserves the hover safe triangle while crossing a sibling row into a portal", async () => {
  await page.viewport(1400, 900);
  const action = vi.fn();
  await open([
    {
      label: "Move",
      children: [
        { label: "Nested", children: [{ label: "First" }, { label: "Target", action }] },
        { label: "Sibling" },
      ],
    },
  ]);
  const trigger = document.activeElement as HTMLElement;
  let point = pagePoint(trigger);
  await mouse.moveTo(point.x, point.y);
  await menusSettled();
  const parent = childOf(trigger);
  const nested = parent.querySelector<HTMLElement>(".menu-submenu-entry > button")!;
  point = pagePoint(nested);
  await mouse.moveTo(point.x, point.y);
  await menusSettled();
  const child = childOf(nested);
  const target = [...child.querySelectorAll<HTMLElement>(":scope > button")][1];
  const row = nested.getBoundingClientRect();
  // Leave down-right onto the plain sibling. Without the portal resolver,
  // the grace triangle is lost here and this still-visible branch closes.
  point = pagePoint(nested, 0.97, 1 + 1 / row.height);
  await mouse.moveTo(point.x, point.y);
  expect(child.isConnected).toBe(true);
  expect(nested.getAttribute("aria-expanded")).toBe("true");
  point = pagePoint(target);
  await mouse.moveTo(point.x, point.y);
  expectPainted(target, parent);
  await mouse.press(point.x, point.y);
  await mouse.release(point.x, point.y);
  expect(action).toHaveBeenCalledOnce();
  expect(document.querySelector(".context-menu")).toBeNull();
});

it("reanchors after a parent menu scroll and closes a branch when its trigger scrolls away", async () => {
  await page.viewport(1400, 560);
  const { input } = await open([
    {
      label: "Move",
      children: [
        ...Array.from({ length: 6 }, (_, index) => ({ label: `Before ${index + 1}` })),
        { label: "Nested", children: [{ label: "Target" }] },
        ...Array.from({ length: 35 }, (_, index) => ({ label: `After ${index + 1}` })),
      ],
    },
  ]);
  const trigger = document.activeElement as HTMLElement;
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  await userEvent.keyboard("{ArrowDown}".repeat(6) + "{ArrowRight}");
  await twoFrames();
  const parent = childOf(trigger);
  const nested = parent.querySelector<HTMLElement>(".menu-submenu-entry > button")!;
  const child = childOf(nested);
  await menusSettled();
  const beforeTop = child.getBoundingClientRect().top;
  parent.scrollTop = 28;
  await twoFrames();
  expect(child.getBoundingClientRect().top).toBeCloseTo(beforeTop - 28, 0);
  expectPainted(child.querySelector<HTMLElement>("button")!, parent);
  expect(parent.isConnected).toBe(true);

  parent.scrollTop = 280;
  await twoFrames();
  expect(nested.getBoundingClientRect().bottom).toBeLessThan(parent.getBoundingClientRect().top);
  expect(child.isConnected).toBe(false);
  expect(nested.getAttribute("aria-expanded")).toBe("false");
  expect(parent.isConnected).toBe(true);
  expect(document.activeElement).toBe(parent);
  expect(parent.scrollTop).toBe(280);
  await userEvent.keyboard("{Home}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Before 1");
  expectPainted(document.activeElement as HTMLElement);
  expect(input).not.toHaveBeenCalled();
});

it("dismisses all portal levels on an outside click without stealing the new focus", async () => {
  await page.viewport(900, 560);
  await open([{ label: "Move", children: [{ label: "Nested", children: [{ label: "Target" }] }] }]);
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.querySelectorAll(".context-submenu")).toHaveLength(2);
  await userEvent.click(document.querySelector("#outside")!);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement?.id).toBe("outside");
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

it("keeps the real menubar's Alt capture isolated while a portal owns focus", async () => {
  await page.viewport(1100, 720);
  useStore.setState({ language: "en" });
  const { terminal, input } = await open(
    [{ label: "Move", children: [{ label: "Nested", children: [{ label: "Target" }] }] }],
    undefined,
    true,
  );
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.activeElement?.closest(".context-submenu")).not.toBeNull();
  await userEvent.keyboard("{Alt}");
  expect(document.querySelector(".menubar .menu-dropdown")).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);
  expect(input).not.toHaveBeenCalled();
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
