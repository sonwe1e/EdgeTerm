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

import * as broadcast from "../broadcast";
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

it("copies the request id that ties the failure to the log", async () => {
  act(() => useStore.getState().setError("connection refused", undefined, "req-42"));
  render();

  const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy the message"]');
  await act(async () => {
    copy!.click();
    await Promise.resolve();
  });
  expect(clipboard.writeSystemClipboard).toHaveBeenCalledWith(
    "connection refused\nrequest_id=req-42",
  );
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

it("skips computing broadcast targets while synchronized input is off", () => {
  const spy = vi.spyOn(broadcast, "broadcastTargets");
  render();
  act(() => useStore.getState().setStatus("Ping"));
  expect(spy).not.toHaveBeenCalled();

  act(() => useStore.getState().setBroadcastInput(true));
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

it("toggles the broadcast targets popover cleanly and restores trigger focus on close", () => {
  act(() => useStore.setState({ broadcastInput: true }));
  render();

  const trigger = host.querySelector<HTMLButtonElement>(".broadcast-targets-button")!;
  expect(trigger).toBeTruthy();

  // Dispatch pointerdown and click in separate commits, matching a real
  // browser gesture where pointerdown commits before click runs.
  const pressToggle = () => {
    act(() => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      trigger.click();
    });
  };

  pressToggle();
  expect(host.querySelector(".broadcast-popover")).not.toBeNull();
  // Clicking the trigger again while open must close the popover rather than
  // letting pointerdown dismiss it and click immediately reopen it.
  pressToggle();
  expect(host.querySelector(".broadcast-popover")).toBeNull();

  // Reopen, then close with the header X button: focus returns to the trigger.
  pressToggle();
  const closeButton = host.querySelector<HTMLButtonElement>(".status-popover-close")!;
  act(() => {
    closeButton.focus();
    closeButton.click();
  });
  expect(host.querySelector(".broadcast-popover")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  // Reopen, then press Escape: focus also returns to the trigger.
  pressToggle();
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector(".broadcast-popover")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
