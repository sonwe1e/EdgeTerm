import { page } from "vitest/browser";
import { browserAfterEach, frameFacts, mouse, mount, pagePoint, twoFrames } from "./browserHarness";
import { afterEach, describe, expect, it } from "vitest";
import { createElement, type PointerEvent as ReactPointerEvent } from "react";
// Real Chromium, real stylesheet, real scrolling: the browser project does not
// load the jsdom setup file, so nothing here is stubbed. The component under
// test is the production VirtualFileRows; the rows are the production row
// shape (the .ftp-file-row grid from styles.css) and the pointerdown handler
// is the one production behaviour VirtualFileRows' capture contract builds on
// (FtpPane.beginPress / FilerPanel's rowPointerDown both call
// setPointerCapture on press).
//
// Boundary (scripts/README wording): synthetic entries prove the front-end
// windowing and capture behaviour; they prove nothing about real listings,
// transfers, WebView2 or other browsers' engines.
import "../styles.css";
import { VirtualFileRows } from "../components/VirtualFileRows";

const COUNT = 400;
const PITCH = 29;

interface Row {
  path: string;
  name: string;
}

const entries: Row[] = Array.from({ length: COUNT }, (_, index) => ({
  name: `item-${String(index).padStart(3, "0")}`,
  path: `/remote/item-${String(index).padStart(3, "0")}`,
}));

const pathOf = (index: number): string => entries[index].path;

const rowElement = (entry: Row) =>
  createElement("div", {
    className: "ftp-file-row",
    "data-row": entry.path,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      // The production press behaviour the capture contract builds on.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
  },
  createElement("span", { className: "ftp-file-name" },
    createElement("span", null, entry.name)),
  createElement("span", null, "1 KB"),
  createElement("span", null, "2026-10-15 10:00"),
  );

interface RowsAppProps {
  rowHeight: number;
  resetKey: string;
  list: readonly Row[];
}

const rowsApp = ({ rowHeight, resetKey, list }: RowsAppProps) =>
  createElement("div", {
    className: "ftp-file-browser",
    style: { width: "360px", height: "320px" },
  },
  createElement("div", { className: "ftp-browser-list", "data-list": "" },
    createElement(VirtualFileRows<Row>, {
      entries: list,
      rowHeight,
      resetKey,
      children: (entry: Row) => rowElement(entry),
    })));

const scroller = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>("[data-list]");
  if (!element) throw new Error("no list mounted");
  return element;
};

const mountedRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-file-path]"));

const rowByPath = (path: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(path)}"]`);

/** A row's offset within the scroller's content, in content coordinates. */
const rowTop = (row: HTMLElement): number => {
  const list = scroller();
  return row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
};

/** Every sampled viewport line must be covered by some mounted row. */
const coverage = (): { ok: boolean; gapY: number | null } => {
  const list = scroller();
  const spans = mountedRows().map((row) => ({
    top: rowTop(row),
    bottom: rowTop(row) + row.getBoundingClientRect().height,
  }));
  const top = list.scrollTop;
  const bottom = list.scrollTop + list.clientHeight;
  for (let y = Math.ceil(top); y < bottom; y += 7) {
    if (!spans.some((span) => span.top <= y && y < span.bottom)) {
      return { ok: false, gapY: y };
    }
  }
  return { ok: true, gapY: null };
};

/**
 * Presses a mounted row with real CDP input and proves the press really
 * landed on that row (the trusted pointerdown target), then nudges the
 * pointer: pending pointer capture is processed before the pointer's next
 * event, so the row's setPointerCapture engages there.
 */
async function pressRowHeld(row: HTMLElement): Promise<void> {
  const landed: Array<EventTarget | null> = [];
  const onDown = (event: Event): void => { landed.push(event.target); };
  document.addEventListener("pointerdown", onDown, { once: true, capture: true });
  const at = pagePoint(row);
  await mouse.press(at.x, at.y);
  const facts = `press on ${row.dataset.filePath}; ${frameFacts()}`;
  expect(landed.length, `pointerdown count; ${facts}`).toBe(1);
  expect(row.contains(landed[0] as Node) || landed[0] === row,
    `press target ${String(landed[0])}; ${facts}`).toBe(true);
  await mouse.moveTo(at.x + 2, at.y + 2);
}

describe("VirtualFileRows in a real scrolling container", () => {
  afterEach(async () => {
    await browserAfterEach();
  });

  it("lands real CDP input and really engages pointer capture (input wiring control)", async () => {
    const mountedProbe = mount(createElement("div", {
      "data-probe": "",
      style: { width: "200px", height: "100px", background: "#334" },
    }));
    const mountTarget = mountedProbe.container;
    const probe = document.querySelector<HTMLElement>("[data-probe]")!;
    const seen: { trusted: boolean; pointerId: number }[] = [];
    let gotCapture = false;
    let capturedMoves = 0;
    probe.addEventListener("pointerdown", (event) => {
      seen.push({ trusted: event.isTrusted, pointerId: event.pointerId });
      probe.setPointerCapture(event.pointerId);
    });
    probe.addEventListener("gotpointercapture", () => { gotCapture = true; });
    probe.addEventListener("pointermove", () => { capturedMoves += 1; });

    // Positive control: a real CDP press lands on the element as a trusted
    // event with an active pointer id. Per the Pointer Events spec, pending
    // capture is processed before the pointer's NEXT event is dispatched,
    // so a small move must follow the press before gotpointercapture can
    // be observed.
    const at = pagePoint(probe);
    await mouse.press(at.x, at.y);
    expect(seen.length, `pointerdown seen; ${frameFacts()}`).toBe(1);
    expect(seen[0].trusted, `trusted; ${frameFacts()}`).toBe(true);
    expect(seen[0].pointerId, `pointerId; ${frameFacts()}`).toBeGreaterThan(0);
    await mouse.moveTo(at.x + 2, at.y + 2);
    expect(gotCapture, `gotpointercapture; ${frameFacts()}`).toBe(true);
    expect(probe.hasPointerCapture(seen[0].pointerId),
      `hasPointerCapture; ${frameFacts()}`).toBe(true);
    // While captured, a move delivered anywhere still reaches the probe:
    // the pointer, not the geometry, routes the events.
    await mouse.moveTo(at.x + 300, at.y + 80);
    expect(capturedMoves, `captured moves; ${frameFacts()}`).toBeGreaterThanOrEqual(1);
    await mouse.release(at.x + 300, at.y + 80);
    expect(probe.hasPointerCapture(seen[0].pointerId)).toBe(false);

    // Negative control on a SECOND element: a synthetic (untrusted)
    // pointerdown carries no active pointer, so capture MUST refuse. If a
    // fake event could capture, every "capture" assertion above would be
    // satisfiable by dispatchEvent and prove nothing. The expected error is
    // caught by THIS handler alone; an unexpected failure anywhere else
    // still fails the test.
    const other = document.createElement("div");
    other.style.width = "60px";
    other.style.height = "40px";
    mountTarget.append(other);
    let syntheticCaptureRefused = false;
    other.addEventListener("pointerdown", (event) => {
      try {
        other.setPointerCapture(event.pointerId);
      } catch {
        syntheticCaptureRefused = true;
      }
    });
    other.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, bubbles: true }));
    expect(syntheticCaptureRefused).toBe(true);
    expect(other.hasPointerCapture(7)).toBe(false);
  });

  it("mounts only the window around the viewport and covers it fully", async () => {
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();

    const list = scroller();
    expect(list.scrollTop).toBe(0);
    // Virtualization: 400 entries, far fewer than that in the DOM…
    expect(mountedRows().length).toBeLessThan(100);
    // …but the visible band and its overscan are all there: the first row
    // exists and every sampled line of the viewport is covered.
    expect(rowByPath(pathOf(0))).not.toBeNull();
    const result = coverage();
    expect(result.gapY).toBeNull();

    // Rows sit at their content offset: the pitch the wrapper style declares
    // is the pitch the layout really has.
    const first = rowByPath(pathOf(0))!;
    expect(first.getBoundingClientRect().height).toBe(PITCH);
  });

  it("covers the top and bottom extremes and clamps runaway scroll", async () => {
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();

    const list = scroller();
    // Top: row 0 at the very start.
    expect(rowTop(rowByPath(pathOf(0))!)).toBe(0);

    // A scroll past the end clamps to the real maximum (wrong input, still
    // covered).
    list.scrollTop = 999_999;
    await twoFrames();
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);

    // Bottom: the last row is mounted, sits at its content offset, and the
    // viewport bottom is covered to the last pixel line.
    const last = rowByPath(pathOf(COUNT - 1));
    expect(last).not.toBeNull();
    expect(rowTop(last!)).toBe((COUNT - 1) * PITCH);
    expect(coverage().gapY).toBeNull();

    // And back to the top, the last row is released again.
    list.scrollTop = 0;
    await twoFrames();
    expect(rowByPath(pathOf(0))).not.toBeNull();
    expect(rowByPath(pathOf(COUNT - 1))).toBeNull();
  });

  it("re-measures when the rowHeight input changes and keeps coverage", async () => {
    // Component-input contract: VirtualFileRows must follow whatever pitch
    // its parent hands it. The production font-size link (a settings change
    // reaching this prop through a real panel) is proven separately in the
    // responsive suite against the real FilerPanel.
    const mountedApp = mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();
    scroller().scrollTop = 2000;
    await twoFrames();
    const before = mountedRows().length;

    // A larger pitch (the Filer's font-size change moves its rowHeight like
    // this) must re-measure: window positions follow the new pitch.
    mountedApp.render(rowsApp({ rowHeight: 48, resetKey: "a", list: entries }));
    await twoFrames();

    const list = scroller();
    // The spacer grew with the new pitch…
    expect(Number(list.firstElementChild!.getBoundingClientRect().height))
      .toBe(COUNT * 48);
    // …and a row keeps its content offset under the new pitch.
    const someRow = mountedRows()[2];
    const index = entries.findIndex((entry) => entry.path === someRow.dataset.filePath);
    expect(rowTop(someRow)).toBeCloseTo(index * 48, 0);

    // Coverage still holds at the new pitch, top and bottom.
    list.scrollTop = 0;
    await twoFrames();
    expect(coverage().gapY).toBeNull();
    list.scrollTop = 999_999;
    await twoFrames();
    expect(rowByPath(pathOf(COUNT - 1))).not.toBeNull();
    expect(coverage().gapY).toBeNull();

    // The window itself was rebuilt for the new pitch, not recycled.
    expect(mountedRows().length).not.toBe(before);
  });

  it("a resetKey change returns to the top and drops a captured row", async () => {
    const mountedApp = mount(rowsApp({ rowHeight: PITCH, resetKey: "dir-a", list: entries }));
    await twoFrames();
    scroller().scrollTop = 5000;
    await twoFrames();
    expect(rowByPath(pathOf(0))).toBeNull();

    // Hold a real pointer on a row that is about to fall out of the window.
    const held = rowByPath(pathOf(180))!;
    await pressRowHeld(held);
    scroller().scrollTop = 9000;
    await twoFrames();
    // Captured rows stay mounted even when scrolled out (the keep-alive).
    expect(rowByPath(pathOf(180)), `${frameFacts()}`).not.toBeNull();

    // A directory change / sort flip (new resetKey) resets the scroll AND
    // releases the capture bookkeeping: the kept row is recycled.
    mountedApp.render(rowsApp({ rowHeight: PITCH, resetKey: "dir-b", list: entries }));
    await twoFrames();
    expect(scroller().scrollTop).toBe(0);
    expect(rowByPath(pathOf(0))).not.toBeNull();
    expect(rowByPath(pathOf(180))).toBeNull();
    const heldAt = mouse.held();
    if (heldAt) await mouse.release(heldAt.x, heldAt.y);
  });

  it("keeps a pointer-captured row across the whole window and recycles it on release", async () => {
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();

    const held = rowByPath(pathOf(6))!;
    let moves = 0;
    held.addEventListener("pointermove", () => { moves += 1; });
    await pressRowHeld(held);
    // A real capture engages: the row is kept.
    expect(rowByPath(pathOf(6))).not.toBeNull();

    // Scroll the row far out of the window with a real wheel gesture at the
    // held pointer's position, then move the pointer somewhere else over
    // the list.
    const at = mouse.held()!;
    await mouse.wheel(at.x, at.y, 2500);
    await twoFrames();
    const list = scroller();
    expect(list.scrollTop, `wheel scroll; ${frameFacts()}`).toBeGreaterThan(1500);
    const scrolled = rowByPath(pathOf(6))!;
    expect(scrolled).not.toBeNull();
    // The source row is now outside the visible band…
    const top = rowTop(scrolled);
    expect(
      top + PITCH < list.scrollTop || top > list.scrollTop + list.clientHeight,
    ).toBe(true);
    // …yet it still receives the pointer: the capture is real, so the drag
    // source survives its own row scrolling away.
    await mouse.moveTo(at.x + 40, at.y + 12);
    expect(moves, `captured moves; ${frameFacts()}`).toBeGreaterThanOrEqual(1);

    // Release: the row leaves the window and is recycled.
    await mouse.release(at.x + 40, at.y + 12);
    await twoFrames();
    expect(rowByPath(pathOf(6))).toBeNull();
  });

  it("the pre-threshold path renders every row without virtualization", async () => {
    // Wrong-input wiring check from the other side: at or below the
    // threshold the list is not virtual at all — every row is real DOM with
    // no spacer height, so a small folder never pays for windowing.
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries.slice(0, 150) }));
    await twoFrames();
    expect(mountedRows().length).toBe(150);
    const spacer = scroller().firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe("");
  });

  it("documents the tool boundary with a screenshot of the real layout", async () => {
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();
    scroller().scrollTop = 2400;
    await twoFrames();
    expect(coverage().gapY).toBeNull();
    await page.screenshot({
      path: "../../.tmp/records/implementation-03/virtual-rows-mid-scroll.png",
    });
  });

  it("the window is already correct one measured frame after a scroll", async () => {
    // Two real frames: the scroll event, the rAF-scheduled measure and the
    // re-render. No wall-clock budget — only the settled window state.
    mount(rowsApp({ rowHeight: PITCH, resetKey: "a", list: entries }));
    await twoFrames();
    scroller().scrollTop = 6000;
    await twoFrames();
    expect(rowByPath(pathOf(206))).not.toBeNull();
    expect(coverage().gapY).toBeNull();
  });
});
