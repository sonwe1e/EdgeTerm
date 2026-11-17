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
const message = ["delete failed: /a", "rename failed: /b", "copy failed: /c"].join("\n");
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

const render = () => act(() => root.render(h(StatusBar)));

it("says how many failures the one visible line stands for", () => {
  act(() => useStore.getState().setError(message));
  render();

  expect(host.textContent ?? "").toContain("delete failed: /a");
  // One line of the batch is shown; the count keeps it from reading as one
  // failure, and the rest stays one press away.
  expect(host.textContent ?? "").toContain("+2 more");
  expect(host.textContent ?? "").not.toContain("copy failed: /c");
  expect(host.querySelector(".status-message")?.getAttribute("title")).toBe(message);
});

it("copies the joined failure, including the lines the bar cannot show", async () => {
  act(() => useStore.getState().setError(message));
  render();

  const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy the message"]');
  expect(copy, "the error area offers a copy button").toBeTruthy();
  await act(async () => {
    copy!.click();
    await Promise.resolve();
  });
  expect(clipboard.writeSystemClipboard).toHaveBeenCalledWith(message);
});

it("shows no count for a single failure and no copy button for a notice", () => {
  act(() => useStore.getState().setError("connection refused"));
  render();
  expect(host.textContent ?? "").toContain("connection refused");
  expect(host.textContent ?? "").not.toContain("more");

  act(() => useStore.getState().setError(null));
  act(() => useStore.getState().setStatus("Connected"));
  render();
  expect(host.querySelector('[aria-label="Copy the message"]')).toBeNull();
});
