import type { TransferOptions } from "./api";
import { TRANSFER_OPTIONS_KEY } from "./persistKeys";

const KEY = TRANSFER_OPTIONS_KEY;
export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = { requests: 32, chunkKib: 128, files: 16, durable: false, tar: false, rateLimitBps: 0 };

/** The whole-job payload limit the backend accepts: 0 (unlimited) or 1 KiB/s to 1 GiB/s. */
export function validRateLimitBps(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    (value === 0 || (value >= 1024 && value <= 1 << 30));
}

export function readTransferOptions(): TransferOptions {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TransferOptions> | null;
    if (value && typeof value.requests === "number" && Number.isInteger(value.requests) && value.requests >= 1 && value.requests <= 32 &&
        typeof value.chunkKib === "number" && Number.isInteger(value.chunkKib) && value.chunkKib >= 16 && value.chunkKib <= 256 &&
        typeof value.files === "number" && Number.isInteger(value.files) && value.files >= 1 && value.files <= 32) {
      // Saved preferences predate `durable`, `tar` and `rateLimitBps`; they
      // keep their concurrency and pick up the defaults instead of being
      // discarded whole. A rate limit outside the backend's range is
      // dropped to unlimited, not clamped to a speed nobody chose.
      return {
        ...DEFAULT_TRANSFER_OPTIONS,
        ...value,
        durable: value.durable === true,
        tar: value.tar === true,
        rateLimitBps: validRateLimitBps(value.rateLimitBps) ? value.rateLimitBps : 0,
      };
    }
  } catch { /* A missing or damaged preference uses the bounded default. */ }
  return { ...DEFAULT_TRANSFER_OPTIONS };
}

export function saveTransferOptions(options: TransferOptions): void {
  localStorage.setItem(KEY, JSON.stringify(options));
}
