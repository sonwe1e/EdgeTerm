import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
function createController(
  callbacks: { onData?: (data: string) => void; onReconnect?: () => void } = {},
) {
  const c = new TerminalController(
    "reconnect-test",
    {
      onData: callbacks.onData ?? (() => {}),
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
      onReconnect: callbacks.onReconnect,
    },
    13,
    100,
  );
  controllers.push(c);
  return c;
}
afterEach(() => controllers.splice(0).forEach((c) => c.dispose()));

/** The exact handler `term.onData` is registered with. */
function keypress(c: TerminalController, data: string): void {
  (c as unknown as { handleData(data: string): void }).handleData(data);
}

describe("Enter reconnects a dead session", () => {
  it("forwards Enter to onReconnect while the terminal is locked", () => {
    const onReconnect = vi.fn();
    const c = createController({ onReconnect });
    c.setLocked(true);
    keypress(c, "\r");
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps every other keystroke local while locked", () => {
    const onData = vi.fn();
    const onReconnect = vi.fn();
    const c = createController({ onData, onReconnect });
    c.setLocked(true);
    // A paste ending in Enter is not the Enter key; only the bare key
    // reconnects.
    for (const data of ["ls", "ls\r", "\n", "\x7f"]) keypress(c, data);
    expect(onData).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("sends Enter to the session as usual once unlocked", () => {
    const onData = vi.fn();
    const onReconnect = vi.fn();
    const c = createController({ onData, onReconnect });
    keypress(c, "\r");
    expect(onData).toHaveBeenCalledWith("\r");
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("ignores Enter while a file transfer owns the stream", () => {
    const onReconnect = vi.fn();
    const c = createController({ onReconnect });
    c.setLocked(true);
    const internals = c as unknown as { zmodem: { isActive(): boolean } };
    vi.spyOn(internals.zmodem, "isActive").mockReturnValue(true);
    keypress(c, "\r");
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
