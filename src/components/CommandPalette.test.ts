import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaletteCommand } from "../commandPalette";
import { COMMAND_RECENTS_KEY } from "../persistKeys";
import { CommandPalette } from "./CommandPalette";

// The component contract: the field is the only focus stop, the arrows walk
// the ranked list, Enter runs the pointed row and closes, and the ARIA pairing
// tells assistive technology which row that is. jsdom has no showModal, so this
// also exercises ModalDialog's documented fallback path.

let host: HTMLDivElement;
let root: Root;

const catalogue = (run: (id: string) => void = () => {}): PaletteCommand[] => [
  {
    id: "shortcut:newSession",
    group: "actions",
    label: "New Session",
    hint: "Open a new session",
    chord: "Alt+N",
    keywords: ["new session"],
    run: () => run("newSession"),
  },
  {
    id: "shortcut:closeSession",
    group: "actions",
    label: "Close Session",
    hint: "Close the focused session",
    chord: "Ctrl+Shift+W",
    keywords: ["close session"],
    run: () => run("closeSession"),
  },
  {
    id: "tab:build",
    group: "tabs",
    label: "Switch to Build server",
    keywords: ["tab"],
    run: () => run("tab"),
  },
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (props: { open: boolean; onClose?: () => void; commands?: PaletteCommand[] }) =>
  act(() =>
    root.render(
      h(CommandPalette, {
        open: props.open,
        onClose: props.onClose ?? (() => {}),
        commands: props.commands ?? catalogue(),
      }),
    ),
  );

const input = (): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(".command-palette-input")!;
const options = (): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));

const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });

const press = (key: string) =>
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

describe("the command palette", () => {
  it("opens with every command grouped and the field focused", () => {
    render({ open: true });
    expect(options()).toHaveLength(3);
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(input());
    // Group headings are read out by the group's own label, not duplicated as
    // stray list items.
    const headings = Array.from(host.querySelectorAll(".command-palette-heading")).map(
      (element) => element.textContent,
    );
    expect(headings).toEqual(["Actions", "Open tabs"]);
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(2);
  });

  it("narrows the list as the reader types and explains an empty result", () => {
    render({ open: true });
    type("close");
    expect(options().map((option) => option.textContent)).toHaveLength(1);
    expect(options()[0].textContent).toContain("Close Session");

    type("zzz");
    expect(options()).toHaveLength(0);
    const empty = host.querySelector('[role="status"]');
    expect(empty?.textContent).toContain("zzz");
  });

  it("moves with the arrow keys, wraps at both ends and keeps the combo announced", () => {
    render({ open: true });
    const announced = () => input().getAttribute("aria-activedescendant");
    expect(announced()).toBe(options()[0].id);

    press("ArrowDown");
    expect(announced()).toBe(options()[1].id);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");

    press("ArrowUp");
    press("ArrowUp");
    expect(announced()).toBe(options()[2].id);

    press("ArrowDown");
    expect(announced()).toBe(options()[0].id);

    press("End");
    expect(announced()).toBe(options()[2].id);
    press("Home");
    expect(announced()).toBe(options()[0].id);

    expect(input().getAttribute("aria-controls")).toBe("command-palette-list");
    expect(input().getAttribute("role")).toBe("combobox");
  });

  it("runs the pointed command on Enter, closes first and records the recents", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render({ open: true, onClose, commands: catalogue(run) });
    press("ArrowDown");
    press("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("closeSession");
    const stored = JSON.parse(localStorage.getItem(COMMAND_RECENTS_KEY) ?? "[]") as string[];
    expect(stored[0]).toBe("shortcut:closeSession");
  });

  it("runs a row on click and points at it while the pointer rests on it", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render({ open: true, onClose, commands: catalogue(run) });
    act(() => {
      options()[2].dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    });
    expect(options()[2].getAttribute("aria-selected")).toBe("true");
    act(() => options()[2].click());
    expect(run).toHaveBeenCalledWith("tab");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on Tab instead of letting focus wander", () => {
    const escapeClose = vi.fn();
    render({ open: true, onClose: escapeClose });
    press("Escape");
    expect(escapeClose).toHaveBeenCalledTimes(1);

    const tabClose = vi.fn();
    render({ open: true, onClose: tabClose });
    press("Tab");
    expect(tabClose).toHaveBeenCalledTimes(1);
  });

  it("starts from a clean field each time it opens", () => {
    render({ open: true });
    type("close");
    expect(input().value).toBe("close");
    render({ open: false });
    render({ open: true });
    expect(input().value).toBe("");
    expect(options()).toHaveLength(3);
  });

  it("shows the chord that runs a command directly", () => {
    render({ open: true });
    const chords = Array.from(host.querySelectorAll(".command-palette-chord")).map(
      (element) => element.textContent,
    );
    expect(chords).toEqual(["Alt+N", "Ctrl+Shift+W"]);
  });

  it("ignores stationary pointermove after keyboard navigation until the pointer moves", () => {
    render({ open: true });
    act(() => {
      options()[2].dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 80 }),
      );
    });
    expect(options()[2].getAttribute("aria-selected")).toBe("true");

    press("ArrowUp");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");

    // Stationary cursor over another row during scroll must not hijack focus.
    act(() => {
      options()[0].dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 80 }),
      );
    });
    expect(options()[1].getAttribute("aria-selected")).toBe("true");

    // Genuine pointer movement resumes hover tracking.
    act(() => {
      options()[0].dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 124, clientY: 82 }),
      );
    });
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });
});
