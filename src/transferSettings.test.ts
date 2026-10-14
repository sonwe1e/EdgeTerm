import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSFER_OPTIONS,
  readTransferOptions,
  saveTransferOptions,
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
    saveTransferOptions({ requests: 32, chunkKib: 128, files: 32, durable: false, tar: false });
    expect(readTransferOptions().files).toBe(32);
  });
});
