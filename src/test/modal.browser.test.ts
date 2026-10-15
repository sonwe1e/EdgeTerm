import { createElement as h, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { ModalDialog } from "../components/ModalDialog";
import "../styles.css";

afterEach(async () => { await browserAfterEach(); vi.restoreAllMocks(); });

for (const fallback of [false, true]) describe(fallback ? "fallback modal" : "native modal", () => {
  const prepare = () => {
    if (fallback) {
      vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
      // Real absence, rather than a fake implementation of the native API.
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
    }
  };
  it("StrictMode keeps child keys, tab boundaries, and controlled close retries", async () => {
    prepare();
    const close = vi.fn(), key = vi.fn();
    mount(h(StrictMode, null, h(ModalDialog, { open: true, onClose: close, title: "Form" },
      h("input", { id: "modal-input", onKeyDown: key }),
      h("button", { hidden: true }, "hidden"), h("button", { id: "last" }, "last"))));
    await twoFrames();
    const input = document.querySelector<HTMLInputElement>("#modal-input")!;
    input.focus();
    await userEvent.keyboard("abc");
    expect(input.value).toBe("abc");
    expect(key).toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>("#last")!.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement?.id).toBe("last");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(2);
    expect(document.querySelector("dialog")?.open).toBe(true);
  });
  it("nested Escape closes only the top and restores the opener", async () => {
    prepare();
    function Fixture() {
      const [outer, setOuter] = useState(false), [inner, setInner] = useState(false);
      return h("div", null, h("button", { id: "opener", onClick: () => setOuter(true) }, "Open"),
        outer && h(ModalDialog, { open: true, onClose: () => setOuter(false), title: "Outer" },
          h("button", { id: "nested-opener", onClick: () => setInner(true) }, "Nested")),
        inner && h(ModalDialog, { open: true, onClose: () => setInner(false), title: "Inner" }, h("button", null, "Inner button")));
    }
    mount(h(StrictMode, null, h(Fixture)));
    await userEvent.click(document.querySelector<HTMLButtonElement>("#opener")!);
    await userEvent.click(document.querySelector<HTMLButtonElement>("#nested-opener")!);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelectorAll("dialog[open]").length).toBe(1);
    expect(document.activeElement?.id).toBe("nested-opener");
    await userEvent.keyboard("{Escape}");
    expect(document.querySelectorAll("dialog[open]").length).toBe(0);
    expect(document.activeElement?.id).toBe("opener");
  });
  it("child Escape cancellation preserves a shortcut draft", async () => {
    prepare();
    const close = vi.fn();
    mount(h(ModalDialog, { open: true, onClose: close, title: "Capture" },
      h("input", { id: "capture", onKeyDown: (e) => { if (e.key === "Escape") e.preventDefault(); } })));
    document.querySelector<HTMLInputElement>("#capture")!.focus();
    await userEvent.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
  });
});
