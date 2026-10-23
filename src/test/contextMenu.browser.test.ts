import { createElement as h, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

afterEach(browserAfterEach);

function Fixture({ items, input }: { items: MenuItem[]; input: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  return h("div", null,
    h("textarea", {
      "aria-label": "Terminal input",
      onKeyDown: (event) => input(event.key),
      onContextMenu: (event) => { event.preventDefault(); setOpen(true); },
    }),
    h("button", { id: "outside" }, "Outside"),
    open && h(ContextMenu, { x: 100, y: 100, items, onClose: () => setOpen(false) }));
}

async function open(items: MenuItem[]) {
  const input = vi.fn();
  mount(h(Fixture, { items, input }));
  const terminal = document.querySelector("textarea")!;
  terminal.focus();
  await userEvent.click(terminal, { button: "right" });
  await twoFrames();
  return { terminal, input };
}

it("owns navigation and Enter while open, without delivering input to the terminal", async () => {
  const action = vi.fn();
  const { terminal, input } = await open([
    { label: "First" }, { label: "Unavailable", disabled: true }, { label: "Run", action },
  ]);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(input).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement).toBe(terminal);
});

it("navigates nested submenus and returns to their parents, then dismisses with Escape", async () => {
  const action = vi.fn();
  const { terminal, input } = await open([
    { label: "Move", children: [{ label: "Nested", children: [{ label: "Target", action }] }] },
  ]);
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Nested");
  await userEvent.keyboard("{ArrowRight}");
  await twoFrames();
  expect(document.activeElement?.textContent).toBe("Target");
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement?.textContent).toBe("Nested");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(terminal);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(input).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});

it("keeps pointer actions working and lets an outside click take focus", async () => {
  const action = vi.fn();
  await open([{ label: "Run", action }]);
  await userEvent.click(document.querySelector(".context-menu button")!);
  expect(action).toHaveBeenCalledTimes(1);
  await userEvent.click(document.querySelector("textarea")!, { button: "right" });
  await userEvent.click(document.querySelector("#outside")!);
  expect(document.querySelector(".context-menu")).toBeNull();
  expect(document.activeElement?.id).toBe("outside");
});
