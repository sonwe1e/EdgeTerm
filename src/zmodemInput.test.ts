import { describe, expect, it, vi } from "vitest";
import Zmodem, { type ReceiveSession, type SendSession, type Session } from "zmodem.js";
import { ZmodemInput } from "./zmodemInput";

const library = Zmodem as typeof Zmodem & {
  Header: { build(name: string, flags?: string[]): { to_hex(): number[] } };
};
const header = (name: string) =>
  Uint8Array.from(
    library.Header.build(
      name,
      name === "ZRINIT" ? ["CANFDX", "CANOVIO", "CANFC32", "ESCCTL"] : undefined,
    ).to_hex(),
  );
const text = (s: string) => new TextEncoder().encode(s);
const flatten = (parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

describe("typed ZMODEM input", () => {
  it("passes large ordinary output through without copying or invoking Sentry", () => {
    const consume = vi.spyOn(Zmodem.Sentry.prototype, "consume");
    const terminal = vi.fn();
    const input = new ZmodemInput({
      to_terminal: terminal,
      sender() {},
      on_detect() {},
      on_retract() {},
    });
    const backing = new Uint8Array(65538).fill(65);
    const bytes = backing.subarray(1, 65537);
    for (let i = 0; i < 100; i++) input.consume(bytes);
    expect(terminal).toHaveBeenCalledTimes(100);
    expect(terminal.mock.calls[0][0]).toBe(bytes);
    expect(consume).not.toHaveBeenCalled();
    consume.mockRestore();
  });

  for (const name of ["ZRQINIT", "ZRINIT"]) {
    const bytes = header(name);
    it.each(Array.from({ length: bytes.length + 1 }, (_, i) => i))(
      `recognizes ${name} split at byte %i after ordinary output`,
      (split) => {
        let session: Session | undefined;
        const input = new ZmodemInput({
          to_terminal() {},
          sender() {},
          on_retract() {},
          on_detect: (d) => {
            session = d.confirm();
          },
        });
        input.consume(text("a long line before the protocol begins\r\n"));
        input.consume(bytes.subarray(0, split));
        input.consume(bytes.subarray(split));
        expect(session?.type).toBe(name === "ZRQINIT" ? "receive" : "send");
      },
    );
  }

  it("preserves false positives, split stars and arbitrary binary terminal bytes", () => {
    const output: Uint8Array[] = [];
    const detect = vi.fn();
    const input = new ZmodemInput({
      to_terminal: (b) => output.push(b),
      sender() {},
      on_detect: detect,
      on_retract() {},
    });
    const parts = [
      text("ordinary*"),
      text("*"),
      Uint8Array.of(24),
      text("B0not-a-header and enough data to expire the probe\r\n"),
      Uint8Array.from({ length: 256 }, (_, i) => i),
      text("tail"),
    ];
    parts.forEach((p) => input.consume(p));
    expect(flatten(output)).toEqual(flatten(parts));
    expect(detect).not.toHaveBeenCalled();
  });

  it("receives a real binary file, skip and empty file, then returns trailing output", async () => {
    const payload = Uint8Array.from({ length: 32791 }, (_, i) => (i * 31) & 255);
    const files: Uint8Array[][] = [];
    const output: Uint8Array[] = [];
    let sending!: SendSession;
    let receiving!: ReceiveSession;
    let resolveSend!: () => void;
    const detected = new Promise<void>((r) => {
      resolveSend = r;
    });
    let peer!: InstanceType<typeof Zmodem.Sentry>;
    // Real protocol engine on both ends, with every packet split into small reads.
    const input = new ZmodemInput({
      to_terminal: (b) => output.push(b),
      on_retract() {},
      sender: (b) => {
        const copy = b.slice();
        queueMicrotask(() => peer.consume(copy));
      },
      on_detect: (d) => {
        receiving = d.confirm() as ReceiveSession;
        receiving.on("offer", (offer) => {
          if (offer.get_details().name === "skip") {
            void offer.skip();
            return;
          }
          const parts: Uint8Array[] = [];
          files.push(parts);
          void offer.accept({ on_input: (b) => parts.push(Uint8Array.from(b)) });
        });
        void receiving.start();
      },
    });
    peer = new Zmodem.Sentry({
      to_terminal() {},
      on_retract() {},
      on_detect: (d) => {
        sending = d.confirm() as SendSession;
        resolveSend();
      },
      sender: (b) => {
        const bytes = Uint8Array.from(b);
        queueMicrotask(() => {
          for (let i = 0; i < bytes.length; i += 97) input.consume(bytes.subarray(i, i + 97));
        });
      },
    });
    // One byte at a time also exercises the replayed ** prefix.
    for (const b of header("ZRQINIT")) input.consume(Uint8Array.of(b));
    await detected;
    const transfer = await sending.send_offer({ name: "binary.dat", size: payload.length });
    await transfer!.end(payload);
    expect(await sending.send_offer({ name: "skip", size: 1 })).toBeUndefined();
    const empty = await sending.send_offer({ name: "empty", size: 0 });
    await empty!.end();
    await sending.close();
    await Promise.resolve();
    input.consume(text("after transfer\r\n"));
    expect(receiving.has_ended()).toBe(true);
    expect(flatten(files[0])).toEqual(payload);
    expect(flatten(files[1])).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(output[output.length - 1])).toBe("after transfer\r\n");
  });
});
