import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
function createController() {
  const c = new TerminalController("flow-test", {
    onData() {}, onResize() {}, onStatus() {}, onCommand() {},
    onCommandState() {}, suggest: () => [], forgetSuggestion() {},
  }, 13, 100);
  controllers.push(c);
  return c;
}
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});

describe("terminal output and resize scheduling", () => {
  it("parses UTF-8 one byte at a time in order and consumes a final partial chunk", async () => {
    const c = createController();
    const bytes = new TextEncoder().encode("你好 🙂\r\nfinal tail");
    const consumed: number[] = [];
    for (let i = 0; i < bytes.length; i++) c.write(bytes.subarray(i, i + 1), () => consumed.push(i));
    await new Promise<void>((resolve) => c.term.write("", resolve));
    expect(consumed).toEqual(Array.from({ length: bytes.length }, (_, i) => i));
    expect(c.term.buffer.active.getLine(0)?.translateToString(true)).toBe("你好 🙂");
    expect(c.term.buffer.active.getLine(1)?.translateToString(true)).toBe("final tail");
  });
  it("acknowledges actual parsing even while the terminal is hidden", async () => {
    const c = createController();
    const done = vi.fn();
    const content = "你好 terminal\r\n";
    const raw = new TextEncoder().encode(content);
    c.write(raw, done);
    expect(done).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => c.term.write("", resolve));
    expect(done).toHaveBeenCalledTimes(1);
    expect(c.term.buffer.active.getLine(0)?.translateToString(true)).toBe("你好 terminal");
  });

  it("consumes raw bytes independently of decoded character length", async () => {
    const c = createController();
    c.setEncoding("gbk");
    const order: number[] = [];
    c.write(Uint8Array.from([0xc4]), () => order.push(1));
    c.write(Uint8Array.from([0xe3, 0xba, 0xc3]), () => order.push(3));
    await new Promise<void>((resolve) => c.term.write("", resolve));
    expect(order).toEqual([1, 3]);
    expect(c.term.buffer.active.getLine(0)?.translateToString(true)).toBe("你好");
  });

  it("does not wait for terminal data when a transfer owns the stream", async () => {
    const c = createController();
    const internals = c as unknown as { xmodem: { isActive(): boolean; consume(bytes: Uint8Array): void } };
    vi.spyOn(internals.xmodem, "isActive").mockReturnValue(true);
    const consume = vi.spyOn(internals.xmodem, "consume").mockImplementation(() => {});
    const raw = Uint8Array.of(1, 2, 3);
    await new Promise<void>((resolve) => c.write(raw, resolve));
    expect(consume).toHaveBeenCalledWith(raw);
    expect(c.term.buffer.active.getLine(0)?.translateToString(true)).toBe("");
  });

});
