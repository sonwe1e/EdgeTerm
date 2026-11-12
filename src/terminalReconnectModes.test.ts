import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "reconnect-modes-test",
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
  controllers.push(controller);
  return controller;
}

const write = (controller: TerminalController, output: string) =>
  new Promise<void>((resolve) => controller.term.write(output, resolve));

afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()));

describe("SSH reconnect terminal modes", () => {
  it("does not carry a dead TUI's mouse, paste, focus, or alternate-buffer modes into a new shell", async () => {
    const controller = createController();
    await write(controller, "previous shell output\r\n");
    await write(controller, "\x1b[?1049h\x1b[?1h\x1b=\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h");

    expect(controller.term.buffer.active.type).toBe("alternate");
    expect(controller.term.modes.mouseTrackingMode).not.toBe("none");
    expect(controller.term.modes.sendFocusMode).toBe(true);
    expect(controller.term.modes.applicationCursorKeysMode).toBe(true);
    expect(controller.term.modes.applicationKeypadMode).toBe(true);
    expect(controller.term.modes.bracketedPasteMode).toBe(true);

    controller.setLocked(true);
    await write(controller, "");
    // Leave the last remote screen visible while disconnected.
    expect(controller.term.buffer.active.type).toBe("alternate");

    controller.setLocked(false);
    await write(controller, "");

    expect(controller.term.modes.mouseTrackingMode).toBe("none");
    expect(controller.term.modes.sendFocusMode).toBe(false);
    expect(controller.term.modes.applicationCursorKeysMode).toBe(false);
    expect(controller.term.modes.applicationKeypadMode).toBe(false);
    expect(controller.term.modes.bracketedPasteMode).toBe(false);
    expect(controller.term.buffer.active.type).toBe("normal");
    expect(controller.term.buffer.normal.getLine(0)?.translateToString().trim()).toBe(
      "previous shell output",
    );
  });

  it("preserves a live TUI's mouse protocol before an actual disconnect", async () => {
    const controller = createController();
    await write(controller, "\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    expect(controller.term.modes.mouseTrackingMode).toBe("vt200");
    expect(controller.term.buffer.active.type).toBe("alternate");

    // A fresh controller is already unlocked: there is no reconnect boundary.
    controller.setLocked(false);
    await write(controller, "");
    expect(controller.term.modes.mouseTrackingMode).toBe("vt200");
    expect(controller.term.buffer.active.type).toBe("alternate");
  });

  it("also resets legacy X10 mouse tracking when a connection is replaced", async () => {
    const controller = createController();
    await write(controller, "\x1b[?9h");
    expect(controller.term.modes.mouseTrackingMode).toBe("x10");

    controller.setLocked(true);
    controller.setLocked(false);
    await write(controller, "");

    expect(controller.term.modes.mouseTrackingMode).toBe("none");
    await write(controller, "\x1b[?1000h");
    expect(controller.term.modes.mouseTrackingMode).toBe("vt200");
  });

  it.each(["47", "1047"])("restores normal buffer after DECSET ?%s on reconnect", async (code) => {
    const controller = createController();
    await write(controller, `\x1b[?${code}h`);
    expect(controller.term.buffer.active.type).toBe("alternate");

    controller.setLocked(true);
    controller.setLocked(false);
    await write(controller, "");
    expect(controller.term.buffer.active.type).toBe("normal");
  });
});
