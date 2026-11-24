import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
function createController() {
  const c = new TerminalController(
    "flow-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
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
    for (let i = 0; i < bytes.length; i++)
      c.write(bytes.subarray(i, i + 1), () => consumed.push(i));
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
    const internals = c as unknown as {
      zmodem: { isActive(): boolean; consume(bytes: Uint8Array): void };
    };
    vi.spyOn(internals.zmodem, "isActive").mockReturnValue(true);
    const consume = vi.spyOn(internals.zmodem, "consume").mockImplementation(() => {});
    const raw = Uint8Array.of(1, 2, 3);
    await new Promise<void>((resolve) => c.write(raw, resolve));
    expect(consume).toHaveBeenCalledWith(raw);
    expect(c.term.buffer.active.getLine(0)?.translateToString(true)).toBe("");
  });

  it("keeps the notice reachable by keyboard while a transfer runs", () => {
    const c = createController();
    const internals = c as unknown as {
      zmodem: { cancel(): boolean };
      transferNotice: HTMLElement;
      showTransferNotice(message: string, kind: "active" | "success" | "error"): void;
    };
    const cancel = vi.spyOn(internals.zmodem, "cancel").mockReturnValue(true);
    const notice = internals.transferNotice;
    // The controller builds the notice but does not mount it; the harness
    // owns that. Without a mount, focus() is a no-op on a detached node.
    document.body.append(notice);

    internals.showTransferNotice("ZMODEM: waiting for a file offer…", "active");
    // While a transfer owns the byte stream the terminal swallows every
    // keystroke, so the notice is the only surface that can act: it has to be
    // in the tab order and hold the keyboard, or a stalled peer leaves a
    // keyboard-only reader with no way out.
    expect(notice.tabIndex).toBe(0);
    expect(document.activeElement).toBe(notice);

    // Esc is the keyboard form of the Cancel button, and it must not also
    // reach the terminal's own key handler.
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    notice.dispatchEvent(escape);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);

    // A result line is not a transfer, so the notice leaves the tab order and
    // hands the keyboard back to the session.
    internals.showTransferNotice("ZMODEM: transfer canceled", "success");
    expect(notice.tabIndex).toBe(-1);
    notice.remove();
  });
  it("offers a cancel control on the notice while an automatic transfer runs", () => {
    const c = createController();
    const internals = c as unknown as {
      zmodem: { cancel(): boolean };
      transferNotice: HTMLElement;
      showTransferNotice(message: string, kind: "active" | "success" | "error"): void;
    };
    const cancel = vi.spyOn(internals.zmodem, "cancel").mockReturnValue(true);
    internals.showTransferNotice("ZMODEM: waiting for a file offer…", "active");
    const button =
      internals.transferNotice.querySelector<HTMLButtonElement>(".transfer-notice-cancel");
    expect(button).not.toBeNull();
    expect(button?.hidden).toBe(false);
    button?.click();
    expect(cancel).toHaveBeenCalledTimes(1);
    // A result line is not a transfer: the control goes away with it.
    internals.showTransferNotice("ZMODEM: transfer canceled", "success");
    expect(button?.hidden).toBe(true);
  });
});
