// IX-02 — the session tree is a keyboard-driven composite widget (role="tree",
// one Tab stop, aria-activedescendant), but its inline edit/delete buttons
// only answered onMouseDown and the tree had no menu key, so a keyboard user
// could connect a saved session yet never edit, duplicate, move or delete one.
// The regression: the menu key (and Shift+F10) opens the row menu, and the
// inline buttons answer a click while staying out of the Tab order.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../../nativeDialog", () => ({ ask: vi.fn(async () => true), open: vi.fn(), save: vi.fn() }));
vi.mock("../../api", async (original) => ({
  ...await original<typeof import("../../api")>(),
  closeSession: vi.fn(async () => {}),
  listSenderCommands: vi.fn(async () => []),
  deleteProfile: vi.fn(async () => {}),
}));

import * as api from "../../api";
import { useStore } from "../../store";
import type { SessionProfile } from "../../types";
import { SessionPanel } from "./SessionPanel";

const initialState = useStore.getState();
let host: HTMLDivElement;
let root: Root;

const profile = (id: string, name: string): SessionProfile => ({
  id, name, kind: "ssh", host: "10.0.1.11", port: 22, username: "deploy",
});

const profiles = [profile("p1", "web-prod-01"), profile("p2", "db-prod-01")];
const rowId = (id: string) => `session-row-${encodeURIComponent(id)}`;

const mount = (onEditProfile = vi.fn()) => {
  act(() => {
    root.render(h(SessionPanel, { onEditProfile, onNewSession: vi.fn() }));
  });
  return onEditProfile;
};

const tree = () => host.querySelector<HTMLDivElement>('.panel-body[role="tree"]')!;
const profileRow = (id: string) => host.querySelector<HTMLElement>(`#${rowId(id)}`)!;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .map((element) => element.textContent?.trim() ?? "");

/** A pointer press on a row marks it active and keeps the tree focused. */
const pressRow = (id: string) => act(() => {
  profileRow(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
});
/** A key pressed while the tree itself holds focus, the way a user's is. */
const treeKey = (init: KeyboardEventInit) => act(() => {
  tree().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  // jsdom implements neither of these; the tree scrolls the active row into
  // view and the panel measures nothing, so both are stubbed.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useStore.setState({ ...initialState, language: "en", profiles, groups: [], tabs: [], activeId: null }, true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Session tree keyboard equivalence (IX-02)", () => {
  it("opens the row menu on the menu key and on Shift+F10", () => {
    mount();
    pressRow("p1");
    expect(tree().getAttribute("aria-activedescendant")).toBe(rowId("p1"));

    treeKey({ key: "ContextMenu" });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(menuItems().some((label) => /Edit/.test(label))).toBe(true);
    expect(menuItems().some((label) => /Delete/.test(label))).toBe(true);

    // Dismiss and reach the same menu through Shift+F10.
    treeKey({ key: "Escape" });
    treeKey({ key: "F10", shiftKey: true });
    expect(menuItems().some((label) => /Edit/.test(label))).toBe(true);
  });

  it("activates the inline edit button on a click, keeping it out of the Tab order", () => {
    const onEditProfile = mount();
    pressRow("p1");

    const buttons = [...profileRow("p1").querySelectorAll<HTMLButtonElement>("button.panel-action")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.tabIndex).toBe(-1);

    const edit = buttons.find((button) => button.getAttribute("aria-label") === "Edit")!;
    act(() => { edit.click(); });
    expect(onEditProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it("reaches delete from the keyboard through the row menu, not only the mouse", async () => {
    mount();
    pressRow("p1");
    treeKey({ key: "ContextMenu" });

    const deleteItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((element) => /Delete/.test(element.textContent?.trim() ?? ""))!;
    await act(async () => { deleteItem.click(); });

    // The confirmation path starts: the scoped-command lookup runs and the
    // delete confirmation dialog takes over.
    expect(api.listSenderCommands).toHaveBeenCalled();
  });
});
