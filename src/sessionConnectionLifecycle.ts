import * as api from "./api";

// Shared by explicit reconnect/cancel and tab-close. No UI/store import: the
// store can retire an attempt before awaiting backend and editor cleanup.
const work = new Map<string, Promise<void>>();
const attempts = new Map<string, number>();
const backendAttempts = new Map<string, number>();
const cleanupNeeded = new Set<string>();
const closingTabs = new Set<string>();
// Tokens must not repeat when a permanently closed tab's maps are released.
let nextAttempt = 0;

export const hasConnectionWork = (id: string): boolean => work.has(id);
export const isConnectionClosing = (id: string): boolean => closingTabs.has(id);
export const needsConnectionCleanup = (id: string): boolean => cleanupNeeded.has(id);
export const connectionAttemptVersion = (id: string): number | undefined => attempts.get(id);

export function invalidateConnectionAttempt(id: string): void {
  attempts.set(id, ++nextAttempt);
}

export function beginTabConnectionClose(id: string): void {
  closingTabs.add(id);
  invalidateConnectionAttempt(id);
}

export function endTabConnectionClose(id: string): void {
  closingTabs.delete(id);
  const version = attempts.get(id);
  const forgetWhenDrained = () => {
    if (attempts.get(id) !== version || closingTabs.has(id)) return;
    const pending = work.get(id);
    if (pending) {
      void pending.then(forgetWhenDrained);
      return;
    }
    attempts.delete(id);
    backendAttempts.delete(id);
    // A failed backend close must still be retried before this id can be
    // reopened. Successful closes already remove their cleanup marker.
  };
  forgetWhenDrained();
}

/** Id-only backend events cannot claim a cancelled/closing owner's UI. */
export const isBackendAttemptCurrent = (id: string): boolean =>
  !closingTabs.has(id) && backendAttempts.get(id) === attempts.get(id);

export function beginConnectionAttempt(id: string) {
  const attempt = ++nextAttempt;
  attempts.set(id, attempt);
  const previous = work.get(id);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  work.set(id, finished);
  return {
    previous,
    current: () => attempts.get(id) === attempt && !closingTabs.has(id),
    claimBackend: () => backendAttempts.set(id, attempt),
    finish: () => {
      if (work.get(id) === finished) work.delete(id);
      release();
    },
  };
}

/** A failed close has to succeed before the same id can be opened again. */
export async function closeConnection(id: string): Promise<void> {
  try {
    await api.closeSession(id);
    cleanupNeeded.delete(id);
  } catch (error) {
    cleanupNeeded.add(id);
    throw error;
  }
}

/** A cancel can finish after its handshake: a retry must await both operations. */
export function holdConnectionCleanup(id: string, cleanup: Promise<void>): void {
  const previous = work.get(id);
  const settled = Promise.allSettled(previous ? [previous, cleanup] : [cleanup]).then(
    () => undefined,
  );
  work.set(id, settled);
  void settled.then(() => {
    if (work.get(id) === settled) work.delete(id);
  });
}
