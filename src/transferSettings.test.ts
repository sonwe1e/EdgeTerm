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
      files: 8,
      durable: false,
    });
  });

  it("keeps concurrency saved before durable existed and defaults it off", () => {
    localStorage.setItem(
      "edgeterm.transfer-options",
      JSON.stringify({ requests: 8, chunkKib: 64, files: 2 }),
    );
    expect(readTransferOptions()).toEqual({
      requests: 8,
      chunkKib: 64,
      files: 2,
      durable: false,
    });
  });

  it("preserves an explicit durable preference", () => {
    saveTransferOptions({ ...DEFAULT_TRANSFER_OPTIONS, durable: true });
    expect(readTransferOptions().durable).toBe(true);
  });

  it("falls back to the defaults when a value is out of bounds", () => {
    for (const override of [{ files: 0 }, { files: 17 }, { requests: 33 }, { chunkKib: 8 }]) {
      localStorage.setItem(
        "edgeterm.transfer-options",
        JSON.stringify({ ...DEFAULT_TRANSFER_OPTIONS, ...override }),
      );
      expect(readTransferOptions()).toEqual(DEFAULT_TRANSFER_OPTIONS);
    }
  });
});
