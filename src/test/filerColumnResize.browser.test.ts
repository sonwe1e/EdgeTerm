import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames } from "./browserHarness";
import { FilerPanel } from "../components/panels/FilerPanel";
import { measureCssLength } from "../filerColumns";
import { useStore } from "../store";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  localHome: vi.fn(async () => "/columns-browser"),
  localList: vi.fn(async (path: string) => ({ path, entries: Array.from({ length: 12 }, (_, index) => ({
    name: `file${index}.txt`, path: `${path}/file${index}.txt`, isDir: false, isSymlink: false,
    size: 10, modified: 1, permissions: null, owner: null, group: null,
  })) })),
  startFileDrag: vi.fn(async () => {}), localRemove: vi.fn(async () => {}),
  onRemoteEditState: async () => () => {},
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

// Real Chromium, real stylesheet, real pointer capture: jsdom cannot answer
// whether a boundary lands where a drag leaves it. The contract under test is
// the one every resizable grid promises — the boundary a user drags follows
// the pointer and stops at its neighbour's floor, and a boundary nobody is
// holding never travels on its own. Both drags of the size/date boundary are
// strict two-column trades: whichever counted column runs out of room ends
// the drag, and the flexible name track only ever pays the size column's
// LEFT handle, which is the one handle that trades with it by design.
const initialState = useStore.getState();

const columns = () => document.querySelector<HTMLElement>(".filer-columns")!;
const sizeCell = () => columns().querySelector<HTMLElement>(".is-size")!;
const dateCell = () => columns().querySelector<HTMLElement>(".is-date")!;
const rightHandle = () => columns().querySelector<HTMLElement>(".is-date .filer-col-resize")!;
const leftHandle = () => columns().querySelector<HTMLElement>(".is-size .filer-col-resize")!;
const panel = () => document.querySelector<HTMLElement>(".filer-panel")!;

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

async function open() {
  await page.viewport(900, 720);
  mount(
    h("div", { style: { width: 460, height: 650, display: "flex", margin: "24px auto" } }, h(FilerPanel)),
  );
  await expect.poll(() => document.querySelector(".filer-entry") !== null).toBe(true);
  await twoFrames();
}

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

it("keeps the size column's left boundary put when its right boundary meets the floor", async () => {
  await open();

  // Give the trade room, strictly through the columns that may pay: the size
  // column's LEFT handle takes 120px from the flexible names (its own design),
  // and then an 80px leftward drag of the size/date boundary has the size
  // column — not the names — pay those 80px into the modified column. (From
  // the untouched state both counted columns sit on their floors, and the
  // strict trade has nothing to move: that inertness is the contract, not a
  // defect the setup may paper over.)
  const widen = pagePoint(leftHandle(), 0.5, 0.5);
  await dragHandleTo(leftHandle, widen.x - 120);
  const start = pagePoint(rightHandle(), 0.5, 0.5);
  await dragHandleTo(rightHandle, start.x - 80);
  const floorBefore = measureCssLength(columns(), "var(--filer-date-floor)");
  expect(floorBefore).not.toBeNull();
  const widened = dateCell().getBoundingClientRect().width;
  expect(Math.abs(widened - (floorBefore! + 80))).toBeLessThanOrEqual(1.5);

  const leftBefore = sizeCell().getBoundingClientRect().left;
  const dateLeftBefore = dateCell().getBoundingClientRect().left;

  // Drag the same boundary right, well past both the 80px it gave and the
  // panel's right edge.
  const rightEdge = pagePoint(panel(), 1.4, 0.5);
  await dragHandleTo(rightHandle, rightEdge.x);

  // The held boundary really travelled: the modified column gave its 80px back.
  const dateLeft = dateCell().getBoundingClientRect().left;
  expect(dateLeft - dateLeftBefore).toBeGreaterThan(40);
  // ...and it stopped at its stylesheet floor, not below it.
  const floor = measureCssLength(columns(), "var(--filer-date-floor)");
  expect(Math.abs(dateCell().getBoundingClientRect().width - floor!)).toBeLessThanOrEqual(1);
  // The boundary nobody was holding — the size column's left edge — stayed put.
  const leftAfter = sizeCell().getBoundingClientRect().left;
  expect(Math.abs(leftAfter - leftBefore)).toBeLessThanOrEqual(1);
});

it("stops widening the modified column at the size floor instead of squeezing the names", async () => {
  await open();

  // Give the leftward drag room to trade: widen the size column with its own
  // left handle — the one handle that trades with the names by design.
  const widen = pagePoint(leftHandle(), 0.5, 0.5);
  await dragHandleTo(leftHandle, widen.x - 120);
  const sizeWidthBefore = sizeCell().getBoundingClientRect().width;
  const sizeFloor = measureCssLength(columns(), "var(--filer-size-floor)");
  expect(sizeFloor).not.toBeNull();
  expect(sizeWidthBefore).toBeGreaterThan(sizeFloor! + 60);

  const leftBefore = sizeCell().getBoundingClientRect().left;
  const dateWidthBefore = dateCell().getBoundingClientRect().width;

  // Now drag the size/date boundary left, well past everything the size
  // column has to give.
  await dragHandleTo(rightHandle, pagePoint(rightHandle(), 0.5, 0.5).x - 300);

  // The size column paid everything down to its floor and stopped there...
  expect(Math.abs(sizeCell().getBoundingClientRect().width - sizeFloor!)).toBeLessThanOrEqual(1);
  // ...the modified column grew by exactly what was paid, no more...
  const grown = dateCell().getBoundingClientRect().width - dateWidthBefore;
  expect(Math.abs(grown - (sizeWidthBefore - sizeFloor!))).toBeLessThanOrEqual(1.5);
  // ...and the name track never paid: the size column's left boundary — the
  // line nobody was holding — kept its place.
  expect(Math.abs(sizeCell().getBoundingClientRect().left - leftBefore)).toBeLessThanOrEqual(1);
});
