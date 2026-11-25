import { createElement as h, type CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MenuBar } from "../components/MenuBar";
import { useStore } from "../store";
import { browserAfterEach, mount, mouse, pagePoint, twoFrames } from "./browserHarness";
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

function mountMenuBar() {
  return mount(
    h(
      "div",
      { className: "app", style: { "--panel-font-size": "12px" } as CSSProperties },
      h(MenuBar, {
        onNewSession() {},
        onFind() {},
        onFindNext() {},
        onCommandPalette() {},
        onSnippets() {},
        broadcast: false,
        onBroadcast() {},
        onFontSettings() {},
        onSettings() {},
        onKeyboardShortcuts() {},
        onCheckForUpdates() {},
        onAbout() {},
      }),
      h("textarea", { "aria-label": "Terminal input" }),
    ),
  );
}

async function openTopMenu(titleText: string) {
  const title = [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find(
    (button) => button.textContent?.trim() === titleText,
  );
  expect(title, `menubar has ${titleText}`).toBeTruthy();
  await userEvent.click(title!);
  await twoFrames();
  const dropdown = document.querySelector<HTMLElement>(".menubar .menu-dropdown");
  expect(dropdown, `${titleText} dropdown is open`).not.toBeNull();
  return dropdown!;
}

async function settledMenus() {
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>(".menu-dropdown")].every((menu) =>
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

function findMenuRow(container: ParentNode, label: string): HTMLButtonElement {
  const row = [...container.querySelectorAll<HTMLButtonElement>(".menu-entry")].find(
    (button) => button.textContent?.trim() === label,
  );
  expect(row, `menu contains "${label}"`).toBeTruthy();
  return row!;
}

function openSubmenuFor(trigger: HTMLButtonElement): HTMLElement {
  const controls = trigger.getAttribute("aria-controls");
  if (controls) {
    const portal = document.getElementById(controls);
    expect(portal, `portal submenu #${controls} exists`).not.toBeNull();
    return portal!;
  }
  const inline = trigger.parentElement?.querySelector<HTMLElement>(":scope > .menu-submenu");
  expect(inline, "submenu panel exists").not.toBeNull();
  return inline!;
}

it("pops View -> Panel Layout and View -> Theme outside the View dropdown without horizontal scrollbars", async () => {
  await page.viewport(1100, 720);
  useStore.setState({ language: "en", theme: "dark" });
  mountMenuBar();

  const viewMenu = await openTopMenu("View");
  await settledMenus();

  for (const [submenuLabel, itemLabel] of [
    ["Panel Layout", "Reset Panel Layout"],
    ["Theme", "Light"],
  ] as const) {
    const trigger = findMenuRow(viewMenu, submenuLabel);
    await userEvent.click(trigger);
    await settledMenus();

    const submenu = openSubmenuFor(trigger);
    const triggerRect = trigger.getBoundingClientRect();
    const subRect = submenu.getBoundingClientRect();

    // Parent dropdown must never grow a horizontal scrollport to trap the submenu.
    expect(
      viewMenu.scrollWidth,
      `${submenuLabel} must not widen View scrollWidth`,
    ).toBeLessThanOrEqual(viewMenu.clientWidth + 1);
    // Submenu must pop out beside its trigger row, fully inside the viewport.
    expect(subRect.width).toBeGreaterThan(100);
    expect(subRect.height).toBeGreaterThan(40);
    expect(subRect.left, `${submenuLabel} pops to the right of its row`).toBeGreaterThanOrEqual(
      triggerRect.right,
    );
    expect(subRect.right).toBeLessThanOrEqual(window.innerWidth - 4);
    expect(subRect.bottom).toBeLessThanOrEqual(window.innerHeight - 4);

    // An item inside the popped submenu must be genuinely hit-testable on screen.
    const child = findMenuRow(submenu, itemLabel);
    const childRect = child.getBoundingClientRect();
    const hit = document.elementFromPoint(
      childRect.left + childRect.width / 2,
      childRect.top + childRect.height / 2,
    );
    expect(child.contains(hit), `${itemLabel} is directly clickable`).toBe(true);
  }

  // Clicking a popped Theme option applies the theme and dismisses the menu cleanly.
  const themeSubmenu = openSubmenuFor(findMenuRow(viewMenu, "Theme"));
  await userEvent.click(findMenuRow(themeSubmenu, "Light"));
  await twoFrames();
  expect(useStore.getState().theme).toBe("light");
  expect(document.querySelector(".menubar .menu-dropdown")).toBeNull();
  expect(document.querySelector(".menubar-submenu")).toBeNull();
});

it("keeps a tall View menu scrollable at 560px height while tracking and hiding portaled submenus", async () => {
  await page.viewport(1100, 560);
  useStore.setState({ language: "en" });
  mountMenuBar();

  const viewMenu = await openTopMenu("View");
  await settledMenus();
  expect(viewMenu.scrollHeight).toBeGreaterThan(viewMenu.clientHeight);

  const layoutTrigger = findMenuRow(viewMenu, "Panel Layout");
  await userEvent.click(layoutTrigger);
  await settledMenus();

  const submenu = openSubmenuFor(layoutTrigger);
  const topBefore = submenu.getBoundingClientRect().top;
  expect(submenu.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    layoutTrigger.getBoundingClientRect().right,
  );
  expect(viewMenu.scrollWidth).toBeLessThanOrEqual(viewMenu.clientWidth + 1);

  // Scrolling while the trigger stays visible moves the portaled submenu with it.
  viewMenu.scrollTop = viewMenu.scrollHeight;
  viewMenu.dispatchEvent(new Event("scroll"));
  await twoFrames();
  expect(submenu.getBoundingClientRect().top).toBeLessThan(topBefore - 40);

  // At a shorter viewport where scrolling pushes the trigger completely above
  // the scrollport, the portaled submenu hides instead of floating orphaned.
  await page.viewport(1100, 320);
  viewMenu.scrollTop = viewMenu.scrollHeight;
  viewMenu.dispatchEvent(new Event("scroll"));
  await twoFrames();
  expect(layoutTrigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    viewMenu.getBoundingClientRect().top + 2,
  );
  expect(!submenu.isConnected || getComputedStyle(submenu).visibility === "hidden").toBe(true);
});

it("supports ArrowRight, ArrowDown, ArrowLeft and Escape across portaled menubar submenus", async () => {
  await page.viewport(1100, 720);
  useStore.setState({ language: "en", theme: "dark" });
  mountMenuBar();

  const viewMenu = await openTopMenu("View");
  const themeTrigger = findMenuRow(viewMenu, "Theme");
  themeTrigger.focus();
  await userEvent.keyboard("{ArrowRight}");
  await settledMenus();

  const submenu = openSubmenuFor(themeTrigger);
  expect(submenu.contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent?.trim()).toBe("Light");

  await userEvent.keyboard("{ArrowLeft}");
  await twoFrames();
  expect(document.activeElement).toBe(themeTrigger);
  expect(themeTrigger.getAttribute("aria-expanded")).toBe("false");

  await userEvent.keyboard("{Escape}");
  await twoFrames();
  expect(document.querySelector(".menubar .menu-dropdown")).toBeNull();
});

it("flips a menubar submenu leftward near the right viewport edge", async () => {
  await page.viewport(420, 640);
  useStore.setState({ language: "en" });
  mountMenuBar();

  const helpMenu = await openTopMenu("Help");
  await settledMenus();
  const langTrigger = findMenuRow(helpMenu, "Language");
  const pt = pagePoint(langTrigger);
  await mouse.moveTo(pt.x, pt.y);
  await settledMenus();

  const submenu = openSubmenuFor(langTrigger);
  const subRect = submenu.getBoundingClientRect();
  expect(subRect.left).toBeGreaterThanOrEqual(4);
  expect(subRect.right).toBeLessThanOrEqual(420 - 4);
});
