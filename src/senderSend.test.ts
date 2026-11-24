import { afterEach, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ writeSession: vi.fn(async () => {}) }));

import * as api from "./api";
import { newStopSignal, sendUnits } from "./senderSend";

afterEach(() => vi.clearAllMocks());

it("reports a failure only after every session has settled, then releases them all", async () => {
  let finishPending!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    finishPending = resolve;
  });
  vi.mocked(api.writeSession)
    .mockRejectedValueOnce(new Error("first session disconnected"))
    .mockReturnValueOnce(pendingWrite);

  const first = sendUnits(["failed", "pending"], ["original\n"], "lf", newStopSignal());
  let settled = false;
  void first.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // The other session is still writing; reporting now would take Stop away
  // from a send that is still in flight. A real tick, not a microtask, so the
  // old reject-on-first-failure path is measurably different.
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settled, "still waiting for the sibling").toBe(false);
  finishPending();
  await expect(first).rejects.toThrow("first session disconnected");

  // Every session settled, so nothing is left reserved for the next send.
  const retry = await sendUnits(["failed", "pending"], ["retry\n"], "lf", newStopSignal());
  expect(retry).toEqual({ sent: ["failed", "pending"], skipped: [] });
});
