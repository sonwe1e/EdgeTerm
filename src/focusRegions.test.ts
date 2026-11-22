import { afterEach, expect, it, vi } from "vitest";
import { focusNextRegion } from "./focusRegions";

function addRegion(child?: HTMLElement, visible = true) {
  const region = document.createElement("div");
  region.dataset.focusRegion = "";
  region.tabIndex = -1;
  // jsdom has no rendered layout; use real focus/DOM and stub visibility geometry.
  vi.spyOn(region, "getClientRects").mockReturnValue({ length: visible ? 1 : 0 } as DOMRectList);
  if (child) region.append(child);
  document.body.append(region);
  return region;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "enters either end when no visible region owns focus (hidden owner: %s)",
  (hiddenOwner) => {
    const first = addRegion();
    addRegion();
    const last = addRegion();
    const outside = hiddenOwner ? addRegion(undefined, false) : document.createElement("button");
    if (!hiddenOwner) document.body.append(outside);

    outside.focus();
    expect(document.activeElement).toBe(outside);
    expect(focusNextRegion(-1)).toBe(true);
    expect(document.activeElement).toBe(last);

    outside.focus();
    expect(focusNextRegion(1)).toBe(true);
    expect(document.activeElement).toBe(first);
  },
);

it("wraps from a focused child and prefers the destination terminal or listbox", () => {
  const listbox = document.createElement("div");
  listbox.setAttribute("role", "listbox");
  listbox.tabIndex = -1;
  addRegion(listbox);
  const terminal = document.createElement("textarea");
  terminal.className = "xterm-helper-textarea";
  addRegion(terminal);

  listbox.focus();
  expect(focusNextRegion(-1)).toBe(true);
  expect(document.activeElement).toBe(terminal);
  expect(focusNextRegion(1)).toBe(true);
  expect(document.activeElement).toBe(listbox);
});

it("leaves focus alone when no visible region exists and can enter the only visible region", () => {
  const hidden = addRegion(undefined, false);
  hidden.focus();
  expect(document.activeElement).toBe(hidden);
  expect(focusNextRegion(-1)).toBe(false);
  expect(document.activeElement).toBe(hidden);

  const only = addRegion();
  expect(focusNextRegion(-1)).toBe(true);
  expect(document.activeElement).toBe(only);
  expect(focusNextRegion(1)).toBe(true);
  expect(document.activeElement).toBe(only);
});
