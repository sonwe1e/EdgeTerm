import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mount, browserAfterEach } from "./browserHarness";
import { TransferCenter } from "../components/TransferCenter";
import { useFileTransfers } from "../fileTransfers";
import { useStore } from "../store";
import type { FileTransfer } from "../api";
import "../styles.css";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  onFileTransfer: vi.fn(async () => () => {}),
  onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []),
  listRecoverableTransfers: vi.fn(async () => []),
}));
const initialStore = useStore.getState();
afterEach(async () => {
  await browserAfterEach();
  useFileTransfers.setState({ open: false, jobs: {} });
  useStore.setState(initialStore, true);
  useStore.getState().setLanguage(initialStore.language);
});

it("keeps the failure actions inside a large-font Chinese transfer row", async () => {
  await page.viewport(900, 560);
  useStore.getState().setLanguage("zh-CN");
  useFileTransfers.getState().update({
    id: "large-font-fixture",
    revision: 1,
    sessionId: "fixture",
    name: "checkpoint.bin",
    context: {
      direction: "upload",
      firstUpload: true,
      local: "C:/a",
      remote: "/b",
      server: "host",
      protocol: "SFTP",
      itemCount: 1,
    },
    status: "error",
    phase: "upload",
    transferred: 20,
    total: 100,
    completedFiles: 0,
    totalFiles: 1,
    failedFiles: ["permission denied"],
    error: { code: "sftp", message: "Permission denied", retryable: true },
    attempt: 1,
    options: { requests: 4, chunkKib: 128, files: 1, durable: false, tar: false, rateLimitBps: 0 },
  });
  mount(h("div", { className: "app", style: { "--panel-font-size": "18px" } }, h(TransferCenter)));
  useFileTransfers.getState().setOpen(true);
  await expect.poll(() => document.querySelectorAll(".transfer-job-actions button").length).toBe(3);
  const head = document.querySelector<HTMLElement>(".transfer-job-head")!.getBoundingClientRect();
  for (const button of document.querySelectorAll<HTMLElement>(".transfer-job-actions button")) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(head.left - 0.5);
    expect(rect.right).toBeLessThanOrEqual(head.right + 0.5);
    expect(rect.height).toBeGreaterThanOrEqual(24);
  }
  const row = document.querySelector<HTMLElement>(".transfer-job")!;
  expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1);
});

it("reveals complete transfer routes and failure messages to keyboard users", async () => {
  await page.viewport(900, 560);
  useStore.getState().setLanguage("en");
  const failure = "models/a-very-long-checkpoint-name.bin: permission denied on the destination";
  const job: FileTransfer = {
    id: "detail-fixture",
    revision: 1,
    sessionId: "fixture",
    name: "checkpoint.bin",
    context: {
      direction: "upload",
      firstUpload: true,
      local: "C:/projects/long/source/checkpoint.bin",
      remote: "/srv/remote/long/checkpoint.bin",
      server: "dev@host:22",
      protocol: "SFTP",
      itemCount: 1,
    },
    status: "error",
    phase: "upload",
    transferred: 20,
    total: 100,
    completedFiles: 0,
    totalFiles: 1,
    failedFiles: [failure],
    error: { code: "sftp", message: "Permission denied", retryable: true },
    attempt: 1,
    options: { requests: 4, chunkKib: 128, files: 1, durable: false, tar: false, rateLimitBps: 0 },
  };
  useFileTransfers.getState().update(job);
  mount(h("div", { className: "app" }, h(TransferCenter)));
  useFileTransfers.getState().setOpen(true);
  const route = page.getByRole("button", { name: "View transfer route for checkpoint.bin" });
  await expect.poll(() => route.elements().length).toBe(1);
  route.element().focus();
  await userEvent.keyboard("{Enter}");
  const detail = document.querySelector<HTMLTextAreaElement>(".transfer-detail-text")!;
  expect(detail.value).toContain("C:/projects/long/source/checkpoint.bin");
  expect(detail.value).toContain("/srv/remote/long/checkpoint.bin");
  expect(getComputedStyle(detail).userSelect).toBe("text");
  expect(document.activeElement).toBe(detail);
  detail.select();
  expect(detail.selectionEnd - detail.selectionStart).toBe(detail.value.length);
  await userEvent.click(page.getByRole("button", { name: "Close details" }));
  await expect.poll(() => document.activeElement).toBe(route.element());
  await userEvent.click(page.getByRole("button", { name: "1 failed files" }));
  await userEvent.click(page.getByRole("button", { name: `View failure details: ${failure}` }));
  expect(document.querySelector<HTMLTextAreaElement>(".transfer-detail-text")?.value).toBe(failure);
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
