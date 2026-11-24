import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mount, browserAfterEach, twoFrames } from "./browserHarness";
import { TransferCenter } from "../components/TransferCenter";
import { useFileTransfers } from "../fileTransfers";
import { useStore } from "../store";
import type { RecoverableTransfer } from "../api";
import "../styles.css";

/**
 * The recovery section's keyboard. "Clear interrupted?" is a question the
 * reader asked for, so declining it has to leave the keyboard where it was -
 * on the action that opened it - rather than dropping it on the document and
 * restarting the next Tab at the top of the window. Clearing one record has
 * to keep the reader inside the list they were working down.
 *
 * Boundary: Chromium over a controlled IPC stub, the panel mounted on its own.
 */

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  onFileTransfer: vi.fn(async () => () => {}),
  onFileTransferRemoved: vi.fn(async () => () => {}),
  listFileTransfers: vi.fn(async () => []),
  listRecoverableTransfers: vi.fn(async () => recoverable),
  discardRecoverableTransfer: vi.fn(async () => {}),
}));

let recoverable: RecoverableTransfer[] = [];
const record = (id: string): RecoverableTransfer =>
  ({
    id,
    sessionId: "fixture",
    name: `${id}.part`,
    direction: "upload",
    local: `C:/${id}.part`,
    remote: `/b/${id}.part`,
    transferred: 10,
    total: 100,
  }) as unknown as RecoverableTransfer;

const initialStore = useStore.getState();
afterEach(async () => {
  await browserAfterEach();
  useFileTransfers.setState({ open: false, jobs: {} });
  useStore.setState(initialStore, true);
  useStore.getState().setLanguage(initialStore.language);
  recoverable = [];
  vi.clearAllMocks();
});

const openWith = async (entries: RecoverableTransfer[]) => {
  recoverable = entries;
  await mount(h(TransferCenter));
  useFileTransfers.getState().setOpen(true);
  await expect.poll(() => document.querySelector("[data-clear-interrupted]")).not.toBeNull();
  await twoFrames();
};

it("returns the keyboard to the action that opened the bulk question", async () => {
  await openWith([record("a"), record("b")]);
  const trigger = document.querySelector<HTMLButtonElement>("[data-clear-interrupted]")!;
  await userEvent.click(trigger);
  await twoFrames();
  expect(document.querySelector(".transfer-clear-band"), "the question is up").not.toBeNull();

  // The band's actions are [do it, cancel]; matched by position so the case
  // does not depend on which language the store happens to be in.
  const band = document.querySelector<HTMLElement>(".transfer-clear-band")!;
  const cancel = band.querySelectorAll<HTMLButtonElement>(".transfer-job-actions button")[1];
  await userEvent.click(cancel);
  await twoFrames();

  expect(document.querySelector(".transfer-clear-band"), "the question is gone").toBeNull();
  // Back on the button that asked, not on the document body and not on the
  // header's Pin button, which is the first head action in document order.
  expect(document.activeElement).toBe(trigger);
});

it("keeps the reader in the interrupted list after clearing one record", async () => {
  await openWith([record("a"), record("b"), record("c")]);
  // The row's own Clear is plain text, so the row is found by its name first.
  const row = [...document.querySelectorAll<HTMLElement>(".transfer-recovery-row")].find(
    (element) => element.querySelector("strong")?.textContent === "a.part",
  );
  expect(row, "the interrupted row").toBeTruthy();
  // [resume, forget] - the last one, again matched by position.
  const actions = row!.querySelectorAll<HTMLButtonElement>(".transfer-job-actions button");
  const clearOne = actions[actions.length - 1];
  expect(clearOne, "a row's own Clear").toBeTruthy();
  await userEvent.click(clearOne!);
  await twoFrames();

  expect(document.activeElement).toBe(document.querySelector("[data-clear-interrupted]"));
});
