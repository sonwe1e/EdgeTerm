import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRef } from "react";
import { usePopoverDismiss } from "./usePopoverDismiss";

function Harness({ open, close }: { open: boolean; close: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, close, root);
  return h(
    "div",
    { tabIndex: -1, className: "statusbar" },
    h(
      "div",
      { ref: root, className: "forward-center" },
      h("button", { type: "button" }, "trigger"),
      h("span", { id: "caption" }, "Remote forwarding"),
    ),
    h("button", { type: "button", id: "outside" }, "outside"),
  );
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  await act(async () => root.render(h(Harness, { open: true, close })));
  return {
    close,
    bar: host.querySelector<HTMLElement>(".statusbar")!,
    inside: host.querySelector<HTMLElement>("#caption")!,
    outside: host.querySelector<HTMLElement>("#outside")!,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

it("ignores the status-bar focus that a click inside the popover causes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const view = await mount();
  try {
    await act(async () => {
      view.inside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      // What the browser does after a pointerdown on a span with no tabindex:
      // focus moves to the status bar (tabIndex=-1), which contains the panel.
      view.bar.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(view.close).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

it("still closes for a real outside pointerdown or a focus move to another control", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const view = await mount();
  try {
    await act(async () => view.outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(view.close).toHaveBeenCalledTimes(1);

    await act(async () => view.outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(view.close).toHaveBeenCalledTimes(2);
  } finally {
    await view.cleanup();
  }
});

it("closes on Escape and returns focus to the popover's first button", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const view = await mount();
  try {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(view.close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(view.bar.querySelector("button"));
  } finally {
    await view.cleanup();
  }
});
