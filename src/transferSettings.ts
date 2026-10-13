import type { TransferOptions } from "./api";

const KEY = "edgeterm.transfer-options";
export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = { requests: 32, chunkKib: 128, files: 8, durable: false };

export function readTransferOptions(): TransferOptions {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TransferOptions> | null;
    if (value && typeof value.requests === "number" && Number.isInteger(value.requests) && value.requests >= 1 && value.requests <= 32 &&
        typeof value.chunkKib === "number" && Number.isInteger(value.chunkKib) && value.chunkKib >= 16 && value.chunkKib <= 256 &&
        typeof value.files === "number" && Number.isInteger(value.files) && value.files >= 1 && value.files <= 16) {
      // Saved preferences predate `durable`; they keep their concurrency
      // and pick up the default instead of being discarded whole.
      return { ...DEFAULT_TRANSFER_OPTIONS, ...value, durable: value.durable === true };
    }
  } catch { /* A missing or damaged preference uses the bounded default. */ }
  return { ...DEFAULT_TRANSFER_OPTIONS };
}

export function saveTransferOptions(options: TransferOptions): void {
  localStorage.setItem(KEY, JSON.stringify(options));
}
