import Zmodem, { type SentryOptions } from "zmodem.js";

/**
 * Keep ordinary terminal output in its original typed buffer. A ZMODEM hex
 * handshake contains CAN (0x18); only that traffic, partial handshakes and
 * confirmed sessions need the library's mutable number[] representation.
 *
 * Two already-displayed bytes are enough to replay the leading ** when CAN
 * falls in the next read. The probe lasts through the longest initial header
 * (21 bytes). No bytes are delayed, so output-consumption ACKs stay accurate.
 */
export class ZmodemInput {
  private sentry: InstanceType<typeof Zmodem.Sentry> | null = null;
  private tail: number[] = [];
  private remaining = 0;
  private replaying = false;

  constructor(
    private readonly options: Omit<SentryOptions, "to_terminal"> & {
      to_terminal: (bytes: Uint8Array) => void;
    },
  ) {}

  consume(bytes: Uint8Array) {
    if (!bytes.length) return;
    const lastCan = bytes.lastIndexOf(0x18);
    if (!this.sentry && lastCan < 0) {
      this.options.to_terminal(bytes);
    } else {
      if (!this.sentry) {
        this.sentry = new Zmodem.Sentry({
          ...this.options,
          to_terminal: (octets) => {
            if (!this.replaying && octets.length) {
              this.options.to_terminal(Uint8Array.from(octets));
            }
          },
        });
        // These bytes have already reached xterm. Replay only to the parser.
        this.replaying = true;
        try {
          this.sentry.consume(this.tail.slice());
        } finally {
          this.replaying = false;
        }
      }
      // Passing an Array avoids the library's extra Uint8Array copy.
      this.sentry.consume(Array.from(bytes));
      this.remaining = lastCan < 0
        ? Math.max(0, this.remaining - bytes.length)
        : Math.max(0, 21 - (bytes.length - lastCan + 2));
      if (!this.sentry.get_confirmed_session() && this.remaining === 0) {
        this.sentry = null;
      }
    }
    // Store numbers, not a tiny view retaining a potentially large IPC buffer.
    this.tail = bytes.length > 1
      ? [bytes[bytes.length - 2], bytes[bytes.length - 1]]
      : [...this.tail.slice(-1), bytes[0]];
  }
}
