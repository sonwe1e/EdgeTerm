import { describe, expect, it } from "vitest";
import { externalSurfaceOwnsKeyboard, surfaceOwnsKeyboard } from "./menuKeyboard";

describe("surfaceOwnsKeyboard", () => {
  it("claims a native dialog and its contents", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const input = document.createElement("input");
    dialog.append(input);
    document.body.append(dialog);
    expect(surfaceOwnsKeyboard(dialog)).toBe(true);
    expect(surfaceOwnsKeyboard(input)).toBe(true);
    dialog.remove();
  });

  it("claims a context menu, which is a portal div rather than a dialog", () => {
    const menu = document.createElement("div");
    menu.className = "context-menu";
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    menu.append(row);
    document.body.append(menu);
    expect(surfaceOwnsKeyboard(menu)).toBe(true);
    expect(surfaceOwnsKeyboard(row)).toBe(true);
    menu.remove();
  });

  it("claims the Sender's hand-rolled popover, which is a div not a dialog", () => {
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    const row = document.createElement("button");
    popover.append(row);
    document.body.append(popover);
    expect(surfaceOwnsKeyboard(popover)).toBe(true);
    expect(surfaceOwnsKeyboard(row)).toBe(true);
    popover.remove();
  });

  it("claims an open menubar dropdown and its portaled submenus for global shortcuts", () => {
    const dropdown = document.createElement("div");
    dropdown.className = "menu-dropdown menubar-submenu";
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    dropdown.append(row);
    document.body.append(dropdown);
    expect(surfaceOwnsKeyboard(dropdown)).toBe(true);
    expect(surfaceOwnsKeyboard(row)).toBe(true);
    // Menubar's own Alt/F10 toggle still sees itself as non-external so it can close.
    expect(externalSurfaceOwnsKeyboard(row)).toBe(false);
    dropdown.remove();
  });

  it("claims an open menubar title button but leaves closed menu titles alone", () => {
    const title = document.createElement("button");
    title.className = "menu-item is-open";
    document.body.append(title);
    expect(surfaceOwnsKeyboard(title)).toBe(true);
    expect(externalSurfaceOwnsKeyboard(title)).toBe(false);

    title.className = "menu-item";
    expect(surfaceOwnsKeyboard(title)).toBe(false);
    title.remove();
  });

  it("leaves the rest of the window to its own handlers", () => {
    const plain = document.createElement("button");
    document.body.append(plain);
    expect(surfaceOwnsKeyboard(plain)).toBe(false);
    expect(surfaceOwnsKeyboard(document.body)).toBe(false);
    expect(surfaceOwnsKeyboard(null)).toBe(false);
    plain.remove();
  });
});
