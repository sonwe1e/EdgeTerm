import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { FilerPanel } from "../components/panels/FilerPanel";
import { lastPaths } from "../components/panels/filerDirectoryCache";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  localHome: vi.fn(async () => "/root"),
  localList: vi.fn(async (path: string) => ({
    path,
    entries:
      path === "/root"
        ? [
            {
              name: "sub",
              path: "/root/sub",
              isDir: true,
              isSymlink: false,
              size: 0,
              modified: 1,
              permissions: null,
              owner: null,
              group: null,
            },
            {
              name: "a.txt",
              path: "/root/a.txt",
              isDir: false,
              isSymlink: false,
              size: 1,
              modified: 1,
              permissions: null,
              owner: null,
              group: null,
            },
          ]
        : [
            {
              name: "b.txt",
              path: path + "/b.txt",
              isDir: false,
              isSymlink: false,
              size: 1,
              modified: 1,
              permissions: null,
              owner: null,
              group: null,
            },
          ],
  })),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const initialState = useStore.getState();

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke() {
    return null;
  },
};

beforeEach(() => {
  localStorage.clear();
  lastPaths.clear();
  useStore.getState().setLanguage("en");
});

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
});

const names = () =>
  [...document.querySelectorAll(".filer-entry .row-label")].map((node) => node.textContent);

it("keeps the current folder visible when navigating and narrowing the path bar", async () => {
  const folder = "/alpha/bravo/charlie/delta/echo/foxtrot/golf";
  const { container } = mount(
    h("div", { style: { width: 360, height: 600, display: "flex" } }, h(FilerPanel)),
  );
  await expect.poll(() => names().length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Edit path" }).click();
  const input = page.getByRole("textbox", { name: "Edit path" });
  await input.fill(folder);
  await userEvent.keyboard("{Enter}");
  const trail = container.querySelector<HTMLElement>(".filer-crumbs")!;
  await expect.poll(() => trail.getAttribute("aria-label")).toBe(folder);
  const current = trail.querySelector<HTMLElement>('[aria-current="location"]')!;
  const fits = () => {
    const bounds = trail.getBoundingClientRect();
    const crumb = current.getBoundingClientRect();
    return crumb.left >= bounds.left - 1 && crumb.right <= bounds.right + 1;
  };
  expect(trail.scrollWidth).toBeGreaterThan(trail.clientWidth);
  expect(fits()).toBe(true);
  (container.firstElementChild as HTMLElement).style.width = "240px";
  await twoFrames();
  expect(fits()).toBe(true);
  trail.scrollLeft = 0;
  await page.getByRole("button", { name: "alpha", exact: true }).click();
  await expect.poll(() => trail.getAttribute("aria-label")).toBe("/alpha");
});

it("names its own keys for assistive technology", async () => {
  mount(h(FilerPanel));
  await twoFrames();
  // F2 renames, Delete removes, Enter opens: none of them come with the
  // listbox pattern, so the list says which keys act on its rows.
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
  expect(list.getAttribute("aria-keyshortcuts")).toBe("F2 Delete Enter");
});

it("drops the filter when the reader walks into another folder", async () => {
  await page.viewport(900, 720);
  mount(
    h(
      "div",
      { style: { width: 440, height: 650, display: "flex", margin: "24px auto" } },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => names().length > 0).toBe(true);
  await twoFrames();

  const filter = document.querySelector<HTMLInputElement>(".filer-filter")!;
  filter.focus();
  await userEvent.keyboard("su");
  await twoFrames();
  expect(names()).toEqual(["sub"]);
  expect(document.querySelector(".filer-filter-count")?.textContent).toBe("1 of 2");

  // Walk into the folder while the filter is still narrowing the old one: the
  // new folder is listed whole, under a cleared filter.
  await userEvent.dblClick(page.getByText("sub", { exact: true }));
  await twoFrames();
  await expect.poll(() => names()).toEqual(["b.txt"]);
  expect(document.querySelector<HTMLInputElement>(".filer-filter")?.value).toBe("");
});
