import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFER_OPTIONS,
  readTransferOptions,
  saveTransferOptions,
  validRateLimitBps,
} from "./transferSettings";

describe("transfer option preferences", () => {
  beforeEach(() => localStorage.clear());

  it("returns the fast small-file defaults when nothing is saved", () => {
    expect(readTransferOptions()).toEqual({
      requests: 32,
      chunkKib: 128,
      files: 16,
      durable: false,
      tar: false,
      rateLimitBps: 0,
    });
  });

  it("keeps concurrency saved before durable and tar existed and defaults them off", () => {
    localStorage.setItem(
      "edgeterm.transfer-options",
      JSON.stringify({ requests: 8, chunkKib: 64, files: 2 }),
    );
    expect(readTransferOptions()).toEqual({
      requests: 8,
      chunkKib: 64,
      files: 2,
      durable: false,
      tar: false,
      rateLimitBps: 0,
    });
  });

  it("preserves an explicit durable preference", () => {
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, durable: true });
    expect(readTransferOptions().durable).toBe(true);
  });

  it("preserves an explicit tar preference", () => {
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, tar: true });
    expect(readTransferOptions().tar).toBe(true);
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, tar: false });
    expect(readTransferOptions().tar).toBe(false);
  });

  it("rejects a non-boolean tar value and falls back to the default", () => {
    for (const value of ["yes", 1, null, {}]) {
      localStorage.setItem(
        "edgeterm.transfer-options",
        JSON.stringify({ ...DEFAULT_TRANSFER_OPTIONS, tar: value }),
      );
      expect(readTransferOptions().tar).toBe(false);
    }
  });

  it("falls back to the defaults when a value is out of bounds", () => {
    for (const override of [{ files: 0 }, { files: 33 }, { requests: 33 }, { chunkKib: 8 }]) {
      localStorage.setItem(
        "edgeterm.transfer-options",
        JSON.stringify({ ...DEFAULT_TRANSFER_OPTIONS, ...override }),
      );
      expect(readTransferOptions()).toEqual(DEFAULT_TRANSFER_OPTIONS);
    }
  });

  it("keeps a saved concurrency at the new upper bound", () => {
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, files: 32 });
    expect(readTransferOptions().files).toBe(32);
  });

  it("preserves a saved rate limit and treats zero as unlimited", () => {
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, rateLimitBps: 512 * 1024 });
    expect(readTransferOptions().rateLimitBps).toBe(512 * 1024);
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, rateLimitBps: 0 });
    expect(readTransferOptions().rateLimitBps).toBe(0);
  });

  it("drops a rate limit outside the backend's range to unlimited, keeping the rest", () => {
    // Below 1 KiB/s, above 1 GiB/s, fractional, negative or non-number
    // values were never a speed the backend accepts.
    for (const value of [500, (1 << 30) + 1, 2048.5, -1024, "fast", null]) {
      localStorage.setItem(
        "edgeterm.transfer-options",
        JSON.stringify({ ...DEFAULT_TRANSFER_OPTIONS, rateLimitBps: value }),
      );
      const read = readTransferOptions();
      expect(read.rateLimitBps).toBe(0);
      expect(read.requests).toBe(DEFAULT_TRANSFER_OPTIONS.requests);
    }
  });

  it("accepts exactly the backend's rate range", () => {
    expect(validRateLimitBps(0)).toBe(true);
    expect(validRateLimitBps(1024)).toBe(true);
    expect(validRateLimitBps(1 << 30)).toBe(true);
    expect(validRateLimitBps(1023)).toBe(false);
    expect(validRateLimitBps((1 << 30) + 1)).toBe(false);
    expect(validRateLimitBps(0.5)).toBe(false);
    expect(validRateLimitBps("1024")).toBe(false);
  });
});
