import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController(events: string[]) {
  const controller = new TerminalController(
    "exit-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState: (state, kind, exit) => events.push(`${state}:${kind}:${exit ?? "none"}`),
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  controllers.push(controller);
  return controller;
}

const write = (controller: TerminalController, text: string) =>
  new Promise<void>((resolve) => controller.term.write(text, resolve));

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("command exit status", () => {
  it("reports the status the shell announces with OSC 133 D", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "false\r\n");
    await write(controller, "\x1b]133;D;7\x07");
    expect(events).toContain("complete:command:7");
  });

  it("reports success as 0 and a bare D as unknown", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "true\r\n");
    await write(controller, "\x1b]133;D;0\x07");
    expect(events).toContain("complete:command:0");

    // A status from the previous command must not leak into this one.
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "echo hi\r\n");
    await write(controller, "\x1b]133;D\x07");
    expect(events).toContain("complete:command:none");
  });

  it("treats a non-numeric status as unknown rather than guessing", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "echo hi\r\n");
    await write(controller, "\x1b]133;D;oops\x07");
    expect(events).toContain("complete:command:none");
  });

  it("walks the failed commands and stops when there is no earlier one", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "false\r\n");
    await write(controller, "\x1b]133;D;7\x07");
    await write(controller, "\x1b]133;C\x07");
    await write(controller, "true\r\n");
    await write(controller, "\x1b]133;D;0\x07");
    const [failed] = controller.failedCommandLines();
    expect(failed, "only the failing command is listed").toBeGreaterThanOrEqual(0);

    expect(controller.jumpToFailedCommand(-1)).toBe(true);
    expect(controller.term.buffer.active.viewportY, "the failed line is on screen").toBe(failed);
    expect(controller.jumpToFailedCommand(-1), "there is no earlier failure").toBe(false);
    expect(controller.jumpToFailedCommand(1), "and none after the landing").toBe(false);
  });
});
