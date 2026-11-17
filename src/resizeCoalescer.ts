export interface ResizeCoalescer {
  /** Reports a new grid; the first of a burst goes out at once. */
  request(cols: number, rows: number): void;
  /** Sends whatever is queued now, without waiting for the interval. */
  flush(): void;
  /** Drops whatever is queued: the session is going away or superseding it. */
  cancel(): void;
}

/**
 * Forwards a stream of terminal-grid reports to `send` at most once per
 * `intervalMs`, always delivering the last one.
 *
 * A pane drag reports a new grid on every frame. Forwarding each one resizes
 * the session's PTY sixty times a second; over SSH every window change is a
 * round trip and a shell redraw, and only the final size is worth anything.
 * The first report of a burst goes out immediately, so a single resize still
 * feels instant, and the rest collapse into one trailing send.
 */
export function createResizeCoalescer(
  send: (cols: number, rows: number) => void,
  intervalMs = 100,
): ResizeCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;
  let hasSent = false;
  let pending: { cols: number; rows: number } | null = null;

  const sendPending = () => {
    timer = null;
    if (!pending) return;
    const { cols, rows } = pending;
    pending = null;
    lastSentAt = Date.now();
    hasSent = true;
    send(cols, rows);
  };

  return {
    request(cols, rows) {
      pending = { cols, rows };
      if (timer !== null) return;
      const wait = hasSent ? Math.max(0, lastSentAt + intervalMs - Date.now()) : 0;
      if (wait === 0) sendPending();
      else timer = setTimeout(sendPending, wait);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      sendPending();
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
