import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mount } from "./browserHarness";
import { SenderPanel } from "../components/panels/SenderPanel";
import { useStore } from "../store";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listSenderCommands: vi.fn(async () => [
    { id: "one", name: "Status", text: "show status", ending: "lf", scope: { type: "global" } },
  ]),
}));

const initial = useStore.getState();
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
});

it("previews a focused command and returns keyboard focus after its options menu", async () => {
  useStore.setState({ language: "en", tabs: [], activeId: null });
  mount(
    h(
      "div",
      { className: "app" },
      h(SenderPanel, {
        compact: true,
        canCompact: true,
        onExpandedChange: vi.fn(),
      }),
    ),
  );
  const send = page.getByRole("button", { name: "Send Status: show status" });
  await expect.poll(() => send.elements().length).toBe(1);
  send.element().focus();
  await expect
    .poll(() => document.querySelector('[role="tooltip"]')?.textContent)
    .toContain("show status");
  await userEvent.keyboard("{Tab}");
  const options = page.getByRole("button", { name: "Options for Status" }).element();
  expect(document.activeElement).toBe(options);
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(options);
});
