import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames } from "./browserHarness";
import { FilerPanel } from "../components/panels/FilerPanel";
import { measureCssLength } from "../filerColumns";
import { useStore } from "../store";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  localHome: vi.fn(async () => "/columns-browser"),
  localList: vi.fn(async (path: string) => ({
    path,
    entries: Array.from({ length: 12 }, (_, index) => ({
      name: `entry${index}.txt`,
      path: `${path}/entry${index}.txt`,
      isDir: false,
      isSymlink: false,
      size: 10,
      modified: 1,
      permissions: null,
      owner: null,
      group: null,
    })),
  })),
  startFileDrag: vi.fn(async () => {}),
  localRemove: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

// Real Chromium, real stylesheet, real pointer capture: jsdom cannot answer
// whether a column lands where a drag leaves it. The contract under test is
// the independent-column one: every column is resized from its own right
// edge, and the column nobody is holding keeps its place. While the name
// column follows the layout it absorbs whatever the counted columns take or
// give up; once it has been dragged it holds a width of its own, the counted
// columns are pushed along, and a listing wider than the panel scrolls
// sideways under a caption row that follows it. A double-click fits one
// column to its content.
const initialState = useStore.getState();

const columns = () => document.querySelector<HTMLElement>(".filer-columns")!;
const nameCell = () => columns().querySelector<HTMLElement>(".is-name")!;
const sizeCell = () => columns().querySelector<HTMLElement>(".is-size")!;
const dateCell = () => columns().querySelector<HTMLElement>(".is-date")!;
const nameHandle = () => columns().querySelector<HTMLElement>(".is-name .filer-col-resize")!;
const sizeHandle = () => columns().querySelector<HTMLElement>(".is-size .filer-col-resize")!;
const dateHandle = () => columns().querySelector<HTMLElement>(".is-date .filer-col-resize")!;
const panel = () => document.querySelector<HTMLElement>(".filer-panel")!;
const list = () => document.querySelector<HTMLElement>(".filer-list")!;
const rowDate = () => document.querySelector<HTMLElement>(".filer-entry .filer-col-date")!;

async function dragHandleTo(handle: () => HTMLElement, x: number) {
  const at = pagePoint(handle(), 0.5, 0.5);
  await mouse.press(at.x, at.y);
  // In steps, the way a hand moves: each move settles a frame, which is what
  // lets the drag's frame batch apply before the next one queues.
  const steps = 4;
  for (let step = 1; step <= steps; step++) {
    await mouse.moveTo(Math.round(at.x + ((x - at.x) * step) / steps), at.y);
  }
  await mouse.release(x, at.y);
  await twoFrames();
}

async function open(width = 460, font = 12) {
  await page.viewport(900, 720);
  useStore.setState({ panelFontSize: font });
  mount(
    h(
      "div",
      {
        className: "app",
        style: {
          width,
          height: 650,
          display: "flex",
          margin: "24px auto",
          "--panel-font-size": `${font}px`,
        },
      },
      h(FilerPanel),
    ),
  );
  await expect.poll(() => document.querySelector(".filer-entry") !== null).toBe(true);
  await twoFrames();
}

it("keeps distinct short filenames readable at the supported large font while retaining the dated columns", async () => {
  await open(300, 18);
  const labels = [...document.querySelectorAll<HTMLElement>(".filer-entry .row-label")];
  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels.slice(0, 2)) {
    expect(label.scrollWidth, label.textContent ?? "").toBeLessThanOrEqual(label.clientWidth + 1);
  }
  const scroller = list();
  await userEvent.click(page.getByRole("button", { name: "More columns" }));
  await twoFrames();
  const date = rowDate();
  expect(date.getBoundingClientRect().right).toBeLessThanOrEqual(
    scroller.getBoundingClientRect().right + 1,
  );
  expect(date.scrollWidth).toBeLessThanOrEqual(date.clientWidth + 1);
  expect(dateCell().getBoundingClientRect().left).toBeCloseTo(date.getBoundingClientRect().left, 1);
  const rightEdge = scroller.scrollLeft;
  scroller.focus();
  await userEvent.keyboard("{ArrowDown}");
  await twoFrames();
  expect(scroller.scrollLeft).toBeCloseTo(rightEdge, 0);
  await userEvent.click(page.getByRole("button", { name: "Names" }));
  expect(scroller.scrollLeft).toBe(0);
});

it("hides and restores the size column without losing its width, and remembers the choice", async () => {
  await open(460, 12);
  await userEvent.click(columns().querySelector<HTMLButtonElement>('[data-sort-key="size"]')!);
  expect(useStore.getState().filerSort.key).toBe("size");
  await dragHandleTo(sizeHandle, pagePoint(sizeHandle(), 0.5, 0.5).x + 40);
  const sizeWidth = sizeCell().getBoundingClientRect().width;
  const nameWidth = nameCell().getBoundingClientRect().width;

  await userEvent.click(page.getByRole("button", { name: "Columns", exact: true }));
  await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Size" }));
  await twoFrames();
  expect(getComputedStyle(sizeCell()).display).toBe("none");
  expect(
    getComputedStyle(document.querySelector<HTMLElement>(".filer-entry .filer-col-size")!).display,
  ).toBe("none");
  expect(nameCell().getBoundingClientRect().width).toBeGreaterThan(nameWidth + 30);
  expect(document.querySelector(".filer-hidden-sort")?.textContent).toContain(
    "Sorted by size, ascending",
  );
  expect(useStore.getState().filerSort.key).toBe("size");
  expect(dateCell().getBoundingClientRect().left).toBeCloseTo(
    rowDate().getBoundingClientRect().left,
    1,
  );
  await expect.poll(() => localStorage.getItem("edgeterm.filerSizeVisible")).toBe("false");

  await browserAfterEach();
  await open(460, 12);
  expect(getComputedStyle(sizeCell()).display).toBe("none");
  await userEvent.click(page.getByRole("button", { name: "Columns", exact: true }));
  await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Size" }));
  await twoFrames();
  expect(sizeCell().getBoundingClientRect().width).toBeCloseTo(sizeWidth, 1);
  expect(dateCell().getBoundingClientRect().left).toBeCloseTo(
    rowDate().getBoundingClientRect().left,
    1,
  );
});

it("reclaims space for names and keeps dates aligned at a narrow width and large font", async () => {
  await open(300, 18);
  await userEvent.click(page.getByRole("button", { name: "More columns" }));
  expect(list().scrollLeft).toBeGreaterThan(0);
  await userEvent.click(page.getByRole("button", { name: "Columns", exact: true }));
  await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Size" }));
  await twoFrames();
  const date = rowDate().getBoundingClientRect();
  const caption = dateCell().getBoundingClientRect();
  expect(caption.left).toBeCloseTo(date.left, 1);
  expect(caption.right).toBeCloseTo(date.right, 1);
  expect(date.right).toBeLessThanOrEqual(list().getBoundingClientRect().right + 1);
  expect(list().scrollWidth).toBeLessThanOrEqual(list().clientWidth + 1);
  expect(list().scrollLeft).toBe(0);
});

it("applies imported and reset column preferences to an already mounted panel", async () => {
  await open();
  useStore.getState().applySettings({
    preferences: {
      "edgeterm.filerSizeVisible": false,
      "edgeterm.filerColumns": { name: 210, size: 130, date: 140 },
    },
  });
  await expect.poll(() => getComputedStyle(sizeCell()).display).toBe("none");
  expect(panel().hasAttribute("data-name-fixed")).toBe(true);
  expect(useStore.getState().exportSettings().preferences?.["edgeterm.filerSizeVisible"]).toBe(
    false,
  );
  useStore.getState().resetSettings();
  await expect.poll(() => getComputedStyle(sizeCell()).display).not.toBe("none");
  expect(panel().hasAttribute("data-name-fixed")).toBe(false);
});

it("opens the column menu from the keyboard after closing it with the mouse", async () => {
  await open();
  const button = page.getByRole("button", { name: "Columns", exact: true });
  await userEvent.click(button);
  expect(document.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
  await userEvent.click(button);
  expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="Columns"]')!.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
});

it("keeps the column menu visibly labeled in a narrow panel at a large font", async () => {
  await open(150, 18);
  const button = document.querySelector<HTMLButtonElement>(".filer-columns-trigger")!;
  const header = button.closest<HTMLElement>(".panel-header")!;
  const title = header.querySelector<HTMLElement>(".panel-title")!;
  for (const [language, label] of [
    ["en", "Columns"],
    ["zh-CN", "显示列"],
  ] as const) {
    useStore.getState().setLanguage(language);
    await expect.poll(() => button.textContent?.trim()).toBe(label);
    const box = button.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(headerBox.left);
    expect(box.right).toBeLessThanOrEqual(headerBox.right);
    expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(box.left + 1);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useStore.setState({ ...initialState, language: "en", tabs: [], activeId: null }, true);
  useStore.getState().setLanguage("en");
});

afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initialState, true);
  useStore.getState().setLanguage(initialState.language);
  vi.restoreAllMocks();
});

it("widens the size column from its own right edge in the untouched state", async () => {
  await open();

  // From the untouched state every counted column sits at its content width —
  // and unlike the trade this replaced, that state is draggable: widening the
  // size column takes the room from the flexible names (the one boundary
  // nobody is holding moves), and the modified column keeps its place.
  const floor = measureCssLength(columns(), "var(--filer-size-floor)");
  expect(floor).not.toBeNull();
  const sizeLeftBefore = sizeCell().getBoundingClientRect().left;
  const dateLeftBefore = dateCell().getBoundingClientRect().left;
  const dateWidthBefore = dateCell().getBoundingClientRect().width;

  await dragHandleTo(sizeHandle, pagePoint(sizeHandle(), 0.5, 0.5).x + 80);

  expect(Math.abs(sizeCell().getBoundingClientRect().width - (floor! + 80))).toBeLessThanOrEqual(
    1.5,
  );
  // The names paid: the boundary nobody was holding — name|size — travelled
  // left by the full 80px the size column took.
  expect(sizeLeftBefore - sizeCell().getBoundingClientRect().left).toBeGreaterThan(75);
  // The size|modified boundary did not move at all: the column after the one
  // being resized keeps both its edges while the names follow the layout.
  expect(Math.abs(dateCell().getBoundingClientRect().left - dateLeftBefore)).toBeLessThanOrEqual(1);
  expect(Math.abs(dateCell().getBoundingClientRect().width - dateWidthBefore)).toBeLessThanOrEqual(
    1,
  );
});

it("narrows a counted column past its suggested width down to the drag floor", async () => {
  await open();

  // The content width is a suggestion, not a cage: the size column may be
  // dragged under it — the value truncates, the tooltip keeps the whole of
  // it — and stops at the operable floor, not at zero.
  const min = measureCssLength(columns(), "var(--filer-size-min)");
  expect(min).not.toBeNull();
  const floor = measureCssLength(columns(), "var(--filer-size-floor)");
  expect(floor).not.toBeNull();

  await dragHandleTo(sizeHandle, pagePoint(sizeHandle(), 0.5, 0.5).x - 300);

  const width = sizeCell().getBoundingClientRect().width;
  expect(Math.abs(width - min!)).toBeLessThanOrEqual(1);
  expect(width).toBeLessThan(floor! - 10);
});

it("moves only the column whose edge is held", async () => {
  await open();

  const sizeWidthBefore = sizeCell().getBoundingClientRect().width;
  const dateWidthBefore = dateCell().getBoundingClientRect().width;

  // Widen the modified column: while the names follow the layout they absorb
  // what the counted columns take, which slides the middle columns left —
  // the invariant is each column's width, not its x: the size column keeps
  // exactly the width it had, and only the modified column grew.
  await dragHandleTo(dateHandle, pagePoint(dateHandle(), 0.5, 0.5).x + 80);

  expect(Math.abs(sizeCell().getBoundingClientRect().width - sizeWidthBefore)).toBeLessThanOrEqual(
    1,
  );
  expect(
    Math.abs(dateCell().getBoundingClientRect().width - (dateWidthBefore + 80)),
  ).toBeLessThanOrEqual(1.5);
});

it("pins the name column at its rendered width and pushes the columns after it", async () => {
  await open();

  const nameWidthBefore = nameCell().getBoundingClientRect().width;
  const sizeLeftBefore = sizeCell().getBoundingClientRect().left;
  const dateLeftBefore = dateCell().getBoundingClientRect().left;
  expect(panel().hasAttribute("data-name-fixed")).toBe(false);

  await dragHandleTo(nameHandle, pagePoint(nameHandle(), 0.5, 0.5).x + 60);

  // The drag began by pinning the name at the width it rendered at, so the
  // whole 60px shows as movement of the boundary the user is holding.
  expect(
    Math.abs(nameCell().getBoundingClientRect().width - (nameWidthBefore + 60)),
  ).toBeLessThanOrEqual(1.5);
  expect(sizeCell().getBoundingClientRect().left - sizeLeftBefore).toBeGreaterThan(55);
  expect(dateCell().getBoundingClientRect().left - dateLeftBefore).toBeGreaterThan(55);
  expect(panel().hasAttribute("data-name-fixed")).toBe(true);
});

it("lets an explicit name resize go below the automatic large-font reserve", async () => {
  await open(300, 18);
  const before = nameCell().getBoundingClientRect().width;
  await dragHandleTo(nameHandle, pagePoint(nameHandle(), 0.5, 0.5).x - 45);
  expect(nameCell().getBoundingClientRect().width).toBeLessThan(before - 30);
});

it("scrolls a listing wider than the panel under a caption that follows it", async () => {
  await open();

  // Fixed columns wider than the panel scroll sideways instead of squeezing
  // anyone: widen the pinned names far past what fits.
  await dragHandleTo(nameHandle, pagePoint(nameHandle(), 0.5, 0.5).x + 400);

  const scroller = list();
  expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);

  // The caption row rides above the scroller and follows it: at any scroll
  // position, each caption sits over the column it names.
  const captionOverRow = () => {
    const caption = dateCell().getBoundingClientRect().left;
    const row = rowDate().getBoundingClientRect().left;
    return Math.abs(caption - row);
  };
  expect(captionOverRow()).toBeLessThanOrEqual(1);

  scroller.scrollLeft = 80;
  await twoFrames();
  expect(scroller.scrollLeft).toBeGreaterThan(0);
  expect(captionOverRow()).toBeLessThanOrEqual(1);
});

it("fits a double-clicked column back to its content", async () => {
  await open();

  const floor = measureCssLength(columns(), "var(--filer-size-floor)");
  expect(floor).not.toBeNull();
  const at = pagePoint(sizeHandle(), 0.5, 0.5);
  await dragHandleTo(sizeHandle, at.x + 200);
  const widened = sizeCell().getBoundingClientRect().width;
  expect(widened - floor!).toBeGreaterThan(150);

  // A double-click measures the column's caption and its values — not the
  // neighbours, not the rows' layout — and sizes the column to what fits.
  sizeHandle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await twoFrames();

  const width = sizeCell().getBoundingClientRect().width;
  const min = measureCssLength(columns(), "var(--filer-size-min)")!;
  expect(width).toBeGreaterThanOrEqual(min - 1);
  // The folder holds `10 B` values, so the caption is the widest thing left:
  // the fit lands under the content width the stylesheet suggests for the
  // widest size there is, and far under the width the drag had reached.
  expect(width).toBeLessThanOrEqual(floor! + 2);
  expect(widened - width).toBeGreaterThan(150);
});
