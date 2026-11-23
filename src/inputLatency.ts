/**
 * Typing latency: how long a keystroke takes to come back as output. It is the
 * number a remote-shell user actually feels — it includes the network round
 * trip, the remote shell's read of the byte and its echo — and it needs no
 * backend support, because the terminal already sees both ends of the trip.
 *
 * It is deliberately NOT called a network round trip: a shell with echo off (a
 * password prompt, a full-screen program) never answers, and then there is no
 * reading to show rather than a wrong one.
 */

/** How many samples the median is taken over. */
const SAMPLE_WINDOW = 5;

/** Older than this and the reading is stale; the chip hides rather than lie. */
export const LATENCY_FRESH_MS = 15_000;

/** A gap this long means a suspended machine or a slept laptop, not latency. */
const ABSURD_GAP_MS = 60_000;

type Listener = () => void;

export class InputLatency {
  private sentAt: number | null = null;
  private samples: number[] = [];
  private latestAt = 0;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly notify: () => void = () => {}) {}

  /** A keystroke (or paste) was handed to the transport. */
  markSent(now: number) {
    this.sentAt = now;
  }

  /**
   * Output came back. The first output after a keystroke is that keystroke's
   * answer: what a shell prints later (a command's result) is not a round trip
   * and must not inflate the number.
   */
  markOutput(now: number): boolean {
    const sent = this.sentAt;
    if (sent === null) return false;
    this.sentAt = null;
    const ms = now - sent;
    if (!Number.isFinite(ms) || ms < 0 || ms > ABSURD_GAP_MS) return false;
    this.samples.push(ms);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
    this.latestAt = now;
    this.scheduleExpiry();
    this.notify();
    return true;
  }

  /** Median of the samples still fresh, or null when there is nothing to show. */
  reading(now: number): { ms: number; samples: number } | null {
    if (this.samples.length === 0) return null;
    if (now - this.latestAt > LATENCY_FRESH_MS) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    const ms = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { ms: Math.round(ms), samples: sorted.length };
  }

  reset() {
    this.sentAt = null;
    this.samples = [];
    this.latestAt = 0;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
    this.notify();
  }

  /** Re-render once the fresh window ends, so a stale chip disappears by itself. */
  private scheduleExpiry() {
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      this.expiry = null;
      this.notify();
    }, LATENCY_FRESH_MS + 50);
  }
}

const meters = new Map<string, InputLatency>();
const listeners = new Set<Listener>();

const notifyAll = () => {
  for (const listener of listeners) listener();
};

export function latencyMeter(sessionId: string): InputLatency {
  let meter = meters.get(sessionId);
  if (!meter) {
    meter = new InputLatency(notifyAll);
    meters.set(sessionId, meter);
  }
  return meter;
}

/** Drops a session's samples; its chip must not outlive the session. */
export function forgetLatency(sessionId: string) {
  const meter = meters.get(sessionId);
  if (!meter) return;
  meter.reset();
  meters.delete(sessionId);
}

export function subscribeLatency(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What the status bar shows, as a stable string so React's snapshot comparison
 * does not spin: "" when there is nothing fresh to report.
 */
export function latencyLabel(
  sessionId: string | null,
  now: number,
  format: (ms: number) => string,
) {
  if (!sessionId) return "";
  const reading = meters.get(sessionId)?.reading(now);
  return reading ? format(reading.ms) : "";
}

/** Clears everything; tests use it so one file's samples cannot leak. */
export function resetLatency() {
  for (const id of [...meters.keys()]) forgetLatency(id);
}
