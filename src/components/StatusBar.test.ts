import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
const clipboard = vi.hoisted(() => ({
  writeSystemClipboard: vi.fn(async (_text: string) => {}),
}));
vi.mock("../systemClipboard", () => clipboard);
// The bar's neighbours poll the backend; this test is about the message area.
vi.mock("./ResourceMonitorBar", () => ({ ResourceMonitorBar: () => null }));
vi.mock("./ForwardCenter", () => ({ ForwardCenter: () => null }));
vi.mock("./TransferCenter", () => ({ TransferCenter: () => null }));

import { useStore } from "../store";
import { StatusBar } from "./StatusBar";

const initial = useStore.getState();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ ...initial, language: "en", error: null }, true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial, true);
  clipboard.writeSystemClipboard.mockClear();
});

it("copies a multi-line failure the bar shows one line of", async () => {
  const message = ["delete failed: /a", "rename failed: /b", "copy failed: /c"].join("\n");
  act(() => useStore.getState().setError(message));
  act(() => root.render(h(StatusBar)));

  // The whole text is in the bar; the bar's one line and ellipsis are styling.
  expect(host.textContent ?? "").toContain("copy failed: /c");

  const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy the message"]');
  expect(copy, "the error area offers a copy button").toBeTruthy();
  await act(async () => {
    copy!.click();
    await Promise.resolve();
  });
  expect(clipboard.writeSystemClipboard).toHaveBeenCalledWith(message);
});

it("offers no copy button for an ordinary notice", () => {
  act(() => useStore.getState().setStatus("Connected"));
  act(() => root.render(h(StatusBar)));
  expect(host.querySelector('[aria-label="Copy the message"]')).toBeNull();
});
