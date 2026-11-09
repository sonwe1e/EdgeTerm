import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readLogWindow: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../useT", async () => {
  const i18n = await vi.importActual<typeof import("../i18n")>("../i18n");
  const translate = (key: import("../i18n").MessageKey) => i18n.translate("en", key);
  return { useT: () => translate };
});

import type { LogWindow } from "../api";
import { LogViewerDialog, type LogViewerTarget } from "./LogViewerDialog";

const target: LogViewerTarget = {
  sessionId: "ssh-a",
  sourceTabId: "ssh-a",
  path: "/logs/worker.log",
  name: "worker.log",
};
const latest: LogWindow = {
  path: target.path,
  start: 100,
  end: 116,
  size: 116,
  content: "first\nlast line\n",
  encoding: "UTF-8",
  modifiedAt: 1,
};
let host: HTMLDivElement;
let root: Root;
let contentHeight: number;
const viewport = () => host.querySelector<HTMLDivElement>(".log-viewer-content")!;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === label,
  )!;
const click = (label: string) => act(async () => button(label).click());
const mount = () => act(async () => root.render(h(LogViewerDialog, { target, onClose() {} })));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  contentHeight = 1200;
  api.readLogWindow.mockResolvedValue(latest);
  // Simulated geometry exercises scroll ownership, not rendered layout.
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("log-viewer-content") ? contentHeight : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("log-viewer-content") ? 300 : 0;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("names the dialog and shows the end of the initial tail window", async () => {
  await mount();
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
    "Large text viewer · Read-only",
  );
  expect(viewport().scrollTop).toBe(900);
});

it("does not report a failed first read as still loading, and Latest retries", async () => {
  api.readLogWindow.mockRejectedValueOnce(new Error("offline"));
  await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  expect(host.querySelector(".log-viewer-range")?.textContent).not.toContain("Loading");
  await click("Latest");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(viewport().scrollTop).toBe(900);
});

it("Latest and Follow track the visible tail, while Stop follow preserves reading position", async () => {
  await mount();
  viewport().scrollTop = 20;
  await click("Latest");
  expect(viewport().scrollTop).toBe(900);
  viewport().scrollTop = 40;
  await click("Follow");
  expect(viewport().scrollTop).toBe(900);
  api.readLogWindow.mockResolvedValue({
    ...latest,
    start: latest.end,
    end: 125,
    size: 125,
    content: "appended\n",
    modifiedAt: 2,
  });
  contentHeight = 1500;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(viewport().scrollTop).toBe(1200);
  expect(host.querySelector("pre")?.textContent).toContain("appended");
  await click("Stop follow");
  viewport().scrollTop = 75;
  const calls = api.readLogWindow.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(api.readLogWindow).toHaveBeenCalledTimes(calls);
  expect(viewport().scrollTop).toBe(75);
});

it("keeps a searched match in charge of scrolling while Follow updates the loaded window", async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const revealMatch = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: revealMatch,
  });
  try {
    await mount();
    await click("Follow");
    const search = host.querySelector<HTMLInputElement>(".log-viewer-search")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "first",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    viewport().scrollTop = 25;
    api.readLogWindow.mockResolvedValue({
      ...latest,
      start: latest.end,
      end: 125,
      size: 125,
      content: "appended\n",
      modifiedAt: 2,
    });
    contentHeight = 1500;
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(host.querySelector("mark")?.textContent).toBe("first");
    expect(revealMatch).toHaveBeenCalledWith({ block: "nearest" });
    expect(viewport().scrollTop).toBe(25);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});
