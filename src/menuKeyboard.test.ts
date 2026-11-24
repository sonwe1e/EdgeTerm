import { describe, expect, it } from "vitest";
import { surfaceOwnsKeyboard } from "./menuKeyboard";

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

  it("leaves the rest of the window to its own handlers", () => {
    const plain = document.createElement("button");
    document.body.append(plain);
    expect(surfaceOwnsKeyboard(plain)).toBe(false);
    expect(surfaceOwnsKeyboard(document.body)).toBe(false);
    expect(surfaceOwnsKeyboard(null)).toBe(false);
    plain.remove();
  });
});
