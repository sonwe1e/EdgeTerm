import { afterEach, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ writeSession: vi.fn(async () => {}) }));

import * as api from "./api";
import { newStopSignal, sendUnits } from "./senderSend";

afterEach(() => vi.clearAllMocks());

it("keeps each session reserved until its own pending send settles after a sibling fails", async () => {
  let finishPending!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    finishPending = resolve;
  });
  vi.mocked(api.writeSession)
    .mockRejectedValueOnce(new Error("first session disconnected"))
    .mockReturnValueOnce(pendingWrite);

  const first = sendUnits(["failed", "pending"], ["original\n"], "lf", newStopSignal());
  await expect(first).rejects.toThrow("first session disconnected");

  try {
    const retry = await sendUnits(["failed", "pending"], ["retry\n"], "lf", newStopSignal());
    expect(retry).toEqual({ sent: ["failed"], skipped: ["pending"] });
    expect(api.writeSession).toHaveBeenCalledTimes(3);
    expect(api.writeSession).not.toHaveBeenCalledWith("pending", "retry\n");
  } finally {
    finishPending();
    await pendingWrite;
    // Let the per-session continuation release its reservation.
    await Promise.resolve();
  }

  await expect(sendUnits(["pending"], ["after\n"], "lf", newStopSignal()))
    .resolves.toEqual({ sent: ["pending"], skipped: [] });
  expect(api.writeSession).toHaveBeenLastCalledWith("pending", "after\n");
});
