import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));

import { defaultShortcuts } from "../shortcuts";
import { ShortcutsDialog } from "./ShortcutsDialog";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("lists the keys the dialog cannot rebind", () => {
  act(() =>
    root.render(
      h(ShortcutsDialog, {
        bindings: defaultShortcuts(),
        onApply: () => {},
        onClose: () => {},
      }),
    ),
  );
  const text = host.textContent ?? "";
  // The file list's own keys: they used to be discoverable only by trying.
  expect(text).toContain("F2");
  expect(text).toContain("Shift+F10");
  expect(text).toContain("Alt");
  expect(text).toContain("File list");
});
