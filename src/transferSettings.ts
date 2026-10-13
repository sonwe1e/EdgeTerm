import type { TransferOptions } from "./api";

const KEY = "edgeterm.transfer-options";
export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = { requests: 32, chunkKib: 128, files: 4 };

export function readTransferOptions(): TransferOptions {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as TransferOptions | null;
    if (value && Number.isInteger(value.requests) && value.requests >= 1 && value.requests <= 32 &&
        Number.isInteger(value.chunkKib) && value.chunkKib >= 16 && value.chunkKib <= 256 &&
        Number.isInteger(value.files) && value.files >= 1 && value.files <= 8) return value;
  } catch { /* A missing or damaged preference uses the bounded default. */ }
  return { ...DEFAULT_TRANSFER_OPTIONS };
}

export function saveTransferOptions(options: TransferOptions): void {
  localStorage.setItem(KEY, JSON.stringify(options));
}
