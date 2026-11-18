import { beforeEach, describe, expect, it } from "vitest";

import {
  PENDING_INPUT_LIMIT,
  bufferPendingInput,
  clearPendingInput,
  takePendingInput,
} from "./pendingInput";

/**
 * What a user types while a session is still connecting. It has to survive the
 * handshake, keep its order, and never leak into a session that is not the one
 * it was typed for.
 */
describe("input typed while connecting", () => {
  beforeEach(() => {
    clearPendingInput("a");
    clearPendingInput("b");
  });

  it("keeps the typed bytes in order until the session connects", () => {
    bufferPendingInput("a", "ls");
    bufferPendingInput("a", " -l\r");
    expect(takePendingInput("a")).toBe("ls -l\r");
    // Taking it hands it over once; a second flush has nothing to send.
    expect(takePendingInput("a")).toBeNull();
  });

  it("does not mix what was typed for different sessions", () => {
    bufferPendingInput("a", "one");
    bufferPendingInput("b", "two");
    expect(takePendingInput("b")).toBe("two");
    expect(takePendingInput("a")).toBe("one");
  });

  it("drops the oldest bytes once the limit is reached", () => {
    bufferPendingInput("a", "x".repeat(PENDING_INPUT_LIMIT));
    bufferPendingInput("a", "tail");
    const kept = takePendingInput("a");
    expect(kept).toHaveLength(PENDING_INPUT_LIMIT);
    expect(kept?.endsWith("tail")).toBe(true);
  });

  it("forgets what was typed when the attempt fails", () => {
    bufferPendingInput("a", "typed into a failed connect");
    clearPendingInput("a");
    expect(takePendingInput("a")).toBeNull();
  });

  it("ignores empty data rather than opening a buffer", () => {
    bufferPendingInput("a", "");
    expect(takePendingInput("a")).toBeNull();
  });
});
