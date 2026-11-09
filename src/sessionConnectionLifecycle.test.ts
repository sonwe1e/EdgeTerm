import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ closeSession: vi.fn(async () => undefined) }));

import * as api from "./api";
import {
  beginConnectionAttempt,
  beginTabConnectionClose,
  closeConnection,
  connectionAttemptVersion,
  endTabConnectionClose,
  hasConnectionWork,
  needsConnectionCleanup,
} from "./sessionConnectionLifecycle";

beforeEach(() => {
  vi.mocked(api.closeSession).mockReset().mockResolvedValue(undefined);
});

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("permanently closed connection bookkeeping", () => {
  it("releases a closed tab's generations only after its pending handshake drains", async () => {
    const id = "lifecycle-close-drain";
    const old = beginConnectionAttempt(id);
    old.claimBackend();
    beginTabConnectionClose(id);
    endTabConnectionClose(id);
    expect(connectionAttemptVersion(id)).toBeDefined();
    expect(hasConnectionWork(id)).toBe(true);
    expect(old.current()).toBe(false);

    old.finish();
    await tick();
    expect(connectionAttemptVersion(id)).toBeUndefined();
    expect(hasConnectionWork(id)).toBe(false);
    expect(old.current()).toBe(false);
  });

  it("does not revive an old closure after the same id's bookkeeping was released", () => {
    const id = "lifecycle-no-generation-aba";
    const old = beginConnectionAttempt(id);
    old.finish();
    beginTabConnectionClose(id);
    endTabConnectionClose(id);
    expect(connectionAttemptVersion(id)).toBeUndefined();

    const next = beginConnectionAttempt(id);
    expect(next.current()).toBe(true);
    expect(old.current()).toBe(false);
    next.finish();
    beginTabConnectionClose(id);
    endTabConnectionClose(id);
  });

  it("does not forget a newer owner when the retired owner's work later settles", async () => {
    const id = "lifecycle-keep-new-owner";
    const old = beginConnectionAttempt(id);
    beginTabConnectionClose(id);
    endTabConnectionClose(id);
    const next = beginConnectionAttempt(id);
    const version = connectionAttemptVersion(id);

    old.finish();
    await tick();
    expect(connectionAttemptVersion(id)).toBe(version);
    expect(next.current()).toBe(true);
    expect(hasConnectionWork(id)).toBe(true);
    next.finish();
    beginTabConnectionClose(id);
    endTabConnectionClose(id);
    expect(connectionAttemptVersion(id)).toBeUndefined();
  });

  it("retains a failed close marker until cleanup really succeeds", async () => {
    const id = "lifecycle-retain-failed-cleanup";
    vi.mocked(api.closeSession).mockRejectedValueOnce(new Error("close failed"));
    beginTabConnectionClose(id);
    await expect(closeConnection(id)).rejects.toThrow("close failed");
    endTabConnectionClose(id);
    expect(connectionAttemptVersion(id)).toBeUndefined();
    expect(needsConnectionCleanup(id)).toBe(true);

    await closeConnection(id);
    expect(needsConnectionCleanup(id)).toBe(false);
  });
});
