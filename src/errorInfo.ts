import type { ErrorCode } from "./bindings";

/** The parts of a failure the UI acts on, however it crossed the IPC boundary. */
export interface ErrorInfo {
  /** The backend's stable category, or `unknown` for legacy string errors. */
  code: ErrorCode;
  /** What to show the user. */
  message: string;
  /** The backend operation that raised the error, when it named one. */
  operation?: string;
  /** The diagnostics request id correlating this failure's log lines. */
  requestId?: string;
}

/**
 * Normalizes whatever a rejected `invoke()` rejected with: the structured
 * `AppError` object commands send now, or the plain string every older
 * command, Tauri plugin and web API still throws. Reading fields off the
 * object shape is defensive on purpose — the wire can carry a value from a
 * version that knows more (or fewer) fields than this build.
 */
export function errorInfo(error: unknown): ErrorInfo {
  if (typeof error === "string") return { code: "unknown", message: error };
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      operation?: unknown;
      requestId?: unknown;
    };
    if (typeof candidate.message === "string") {
      const info: ErrorInfo = {
        code: typeof candidate.code === "string" ? (candidate.code as ErrorCode) : "unknown",
        message: candidate.message,
      };
      if (typeof candidate.operation === "string" && candidate.operation) {
        info.operation = candidate.operation;
      }
      if (typeof candidate.requestId === "string" && candidate.requestId) {
        info.requestId = candidate.requestId;
      }
      return info;
    }
  }
  // A JS Error, a thrown symbol, a rejected `undefined` — anything that is
  // not one of the two wire shapes still deserves a message.
  return { code: "unknown", message: String(error) };
}

/** The message a rejected IPC call should show the user. */
export function errorText(error: unknown): string {
  return errorInfo(error).message;
}

/**
 * Whether the failure is a cancellation. The structured `cancelled` code is
 * the reliable answer; the file-transfer jobs' `transfer cancelled` message
 * predates it and has to keep reading as a cancellation.
 */
export function isCancelled(error: unknown): boolean {
  const info = errorInfo(error);
  return info.code === "cancelled" || info.message.includes("transfer cancelled");
}
