/** Cumulative, ordered ACKs for a single connection's raw output channel. */
export class OutputConsumption {
  private queue: { end: number; done: boolean }[] = [];
  private head = 0;
  private received = 0;
  private consumed = 0;
  private acknowledged = 0;
  private scheduled = false;
  private sending = false;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly acknowledge: (consumed: number) => Promise<void>) {}

  receive(bytes: number): () => void {
    const chunk = { end: (this.received += bytes), done: false };
    this.queue.push(chunk);
    return () => {
      if (chunk.done || this.stopped) return;
      chunk.done = true;
      while (this.queue[this.head]?.done) {
        this.consumed = this.queue[this.head++].end;
      }
      if (this.head === this.queue.length || this.head > 1024) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      this.schedule();
    };
  }

  dispose() {
    this.stopped = true;
    this.queue = [];
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }

  private schedule() {
    if (
      this.stopped ||
      this.scheduled ||
      this.sending ||
      this.retry !== null ||
      this.consumed === this.acknowledged
    )
      return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.send();
    });
  }

  private async send() {
    if (this.stopped) return;
    this.sending = true;
    const through = this.consumed;
    try {
      await this.acknowledge(through);
      this.acknowledged = through;
    } catch {
      // An IPC failure must not strand a full output window forever. Since
      // offsets are cumulative, retrying an ACK that landed is harmless.
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          this.retry = null;
          this.schedule();
        }, 100);
      }
    } finally {
      this.sending = false;
      this.schedule();
    }
  }
}
