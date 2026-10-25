import { createElement as h, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { usePopoverDismiss } from "../components/usePopoverDismiss";

afterEach(async () => {
  await browserAfterEach();
  vi.restoreAllMocks();
});

/**
 * The status bar is `tabIndex=-1`, so a real pointerdown on non-interactive
 * text inside a status popover focuses the bar before the click's own label
 * activation runs. The popover must survive that focus move; it is not the
 * user leaving the panel.
 */
function Panel({ open, close }: { open: boolean; close: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, close, root);
  return h(
    "div",
    { className: "statusbar", tabIndex: -1 },
    h(
      "div",
      { className: "forward-center", ref: root },
      h("button", { type: "button" }, "trigger"),
      h("span", { id: "caption" }, "Remote forwarding"),
    ),
  );
}

it("stays open when a click on its text moves focus to the status bar", async () => {
  const close = vi.fn();
  mount(h(Panel, { open: true, close }));
  await twoFrames();
  await userEvent.click(document.querySelector("#caption")!);
  await twoFrames();
  expect(close).not.toHaveBeenCalled();
});

it("still closes for a click outside the panel", async () => {
  const close = vi.fn();
  mount(
    h(
      "div",
      null,
      h(Panel, { open: true, close }),
      h("button", { type: "button", id: "outside" }, "outside"),
    ),
  );
  await twoFrames();
  await userEvent.click(document.querySelector("#outside")!);
  await twoFrames();
  // A real outside click can dismiss on pointerdown and again on the focus
  // move; close is idempotent, so only "it closed" is the contract.
  expect(close).toHaveBeenCalled();
});
