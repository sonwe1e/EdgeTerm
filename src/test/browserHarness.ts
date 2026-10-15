import { cdp } from "vitest/browser";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/**
 * Shared harness for the browser-project contracts. These tests run in a real
 * Chromium page (the vitest browser project, which deliberately does not load
 * the jsdom setup file), so everything here deals in real layout, real pointer
 * input and real timers.
 *
 * Tool boundary, following scripts/README wording: real components and the
 * real stylesheet driven by synthetic data and a controlled IPC boundary.
 * Nothing here proves WebView2/WKWebView/WebKitGTK behaviour or real server
 * throughput.
 */

type Cleanup = () => void;
const cleanups: Cleanup[] = [];

type Mounted = {
  container: HTMLDivElement;
  /** Re-renders this mount's tree, flushed synchronously. */
  render: (next: ReactNode) => void;
};

/** Runs after each test: unmount every tree the test mounted. */
export function cleanupMounts(): void {
  const errors: unknown[] = [];
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch (error) {
      // A failed unmount can leave trees or listeners behind and pollute the
      // next test — record it and keep going so every resource still gets
      // its cleanup attempt, then surface everything.
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    // AggregateError needs lib ES2021; the repo's target is older, so fold
    // every cleanup failure into one error the test run reports.
    const detail = errors
      .map((error, index) => `[${index}] ${String(error)}`)
      .join("\n");
    throw new Error(`browser harness cleanup failed:\n${detail}`);
  }
}

/**
 * The standard afterEach for browser contract files, in the order that
 * matters: release a button a failing assertion left down FIRST (while the
 * tree that captured it still exists), then unmount everything. A failed
 * release is a real failure (the page is alive at afterEach) and must not
 * swallow the cleanup below it; cleanupMounts itself runs in both cases.
 */
export const browserAfterEach = async (): Promise<void> => {
  try {
    await mouse.forceRelease();
  } finally {
    cleanupMounts();
  }
};

/**
 * Mounts `node` under a fresh, full-viewport, positioned wrapper — the same
 * positioning context .ftp-workspace and .pane-slot expect — committed with
 * flushSync so layout effects and their measurements have run when this
 * returns.
 */
export function mount(node: ReactNode): Mounted {
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.width = "100%";
  container.style.height = "100vh";
  document.body.append(container);
  let root: Root | null = createRoot(container);
  const mounted: Mounted = {
    container,
    render(next: ReactNode) {
      flushSync(() => root!.render(next));
    },
  };
  mounted.render(node);
  cleanups.push(() => {
    try {
      root?.unmount();
    } finally {
      // The DOM must not survive a failed unmount to pollute the next test;
      // the error itself still propagates to cleanupMounts.
      root = null;
      container.remove();
    }
  });
  return mounted;
}

export const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * One frame after a CDP input: input-driven pointer events reach their
 * listeners by the next frame, which is what gives React's synthetic
 * handlers and any layout the input caused a chance to run before the test
 * observes state.
 */
const inputSettle = frame;

export const twoFrames = (): Promise<void> =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A point in the OUTER page's viewport — what raw CDP input expects. The
 * tests run in a same-origin iframe whose preview the runner page may scale
 * down, so child-viewport coordinates are mapped through the frame's real
 * transform scale (frameRect / offsetWidth) and its border before being sent
 * outside. With scale 1 and no border this is the plain offset sum.
 */
export function pagePoint(
  element: Element,
  fx = 0.5,
  fy = 0.5,
): { x: number; y: number } {
  const frame = window.frameElement as HTMLIFrameElement | null;
  if (!frame) throw new Error("browser tests run inside an iframe");
  const frameRect = frame.getBoundingClientRect();
  if (frame.offsetWidth === 0) throw new Error("iframe has no layout width");
  const scale = frameRect.width / frame.offsetWidth;
  const originX = frameRect.left + frame.clientLeft * scale;
  const originY = frameRect.top + frame.clientTop * scale;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(originX + (rect.left + rect.width * fx) * scale),
    y: Math.round(originY + (rect.top + rect.height * fy) * scale),
  };
}

/** The frame mapping facts, for failure messages that must explain a miss. */
export function frameFacts(): string {
  const frame = window.frameElement as HTMLIFrameElement;
  const rect = frame.getBoundingClientRect();
  return `frameRect=${Math.round(rect.left)},${Math.round(rect.top)} ` +
    `${Math.round(rect.width)}x${Math.round(rect.height)}` +
    ` offset=${frame.offsetWidth}x${frame.offsetHeight}` +
    ` border=${frame.clientLeft},${frame.clientTop}` +
    ` inner=${window.innerWidth}x${window.innerHeight}` +
    ` scale=${(rect.width / frame.offsetWidth).toFixed(4)}`;
}

type CdpLike = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

let session: CdpLike | null = null;
const cdpSession = (): CdpLike => {
  session ??= cdp() as unknown as CdpLike;
  return session;
};

/**
 * Raw mouse input through the CDP: real browser events with a real active
 * pointer, so setPointerCapture in production handlers engages for real and
 * captured elements really receive the moves. userEvent cannot hold a button
 * across other actions; these helpers can. The pressed state is tracked so a
 * failing test still leaves no button held behind (see `forceRelease`).
 */
let pressedAt: { x: number; y: number } | null = null;

export const mouse = {
  /** True while a CDP button is held; afterEach must clear this. */
  held(): { x: number; y: number } | null {
    return pressedAt;
  },
  async press(x: number, y: number): Promise<void> {
    await cdpSession().send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    pressedAt = { x, y };
    await inputSettle();
  },
  async moveTo(x: number, y: number): Promise<void> {
    // `button` must mirror the real held state: with buttons:1 but button
    // omitted, Chromium drops an active pointer capture on the move
    // (gotpointercapture→lostpointercapture→pointermove — independently
    // reproduced against the same Chromium with four-arm controls). Real
    // drivers (Playwright's RawMouseImpl) always send both fields.
    const held = pressedAt !== null;
    await cdpSession().send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: held ? "left" : "none", buttons: held ? 1 : 0,
    });
    if (held) pressedAt = { x, y };
    await inputSettle();
  },
  async release(x: number, y: number): Promise<void> {
    await cdpSession().send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
    pressedAt = null;
    await inputSettle();
  },
  /**
   * afterEach safety net: if a failing assertion left the button down,
   * release it so no pressed state leaks into the next test. Errors
   * propagate — the page is alive at afterEach, so a failed release is a
   * real failure and must not be dressed up as "session gone".
   */
  async forceRelease(): Promise<void> {
    if (!pressedAt) return;
    const { x, y } = pressedAt;
    await cdpSession().send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
    pressedAt = null;
  },
  /** A native wheel gesture at a point: the scroller under it really scrolls. */
  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    const held = pressedAt !== null;
    await cdpSession().send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY,
      button: held ? "left" : "none", buttons: held ? 1 : 0,
    });
    await inputSettle();
  },
};
