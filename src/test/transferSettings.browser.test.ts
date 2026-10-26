import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mount, browserAfterEach } from "./browserHarness";
import { TransferCenter } from "../components/TransferCenter";
import { useFileTransfers } from "../fileTransfers";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  onFileTransfer: vi.fn(async () => () => {}),
  onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []),
  listRecoverableTransfers: vi.fn(async () => []),
}));
afterEach(async () => {
  await browserAfterEach();
  useFileTransfers.getState().setOpen(false);
});

it("opens transfer settings expanded and moves keyboard focus to their summary", async () => {
  await page.viewport(900, 560);
  mount(h(TransferCenter));
  useFileTransfers.getState().openSettings();
  await expect
    .poll(() => document.querySelector<HTMLDetailsElement>(".transfer-settings")?.open)
    .toBe(true);
  expect(document.activeElement).toBe(document.querySelector(".transfer-settings summary"));
  const input = document.querySelector<HTMLInputElement>(".transfer-settings input")!;
  expect(input.getBoundingClientRect().height).toBeGreaterThan(0);
});
