import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "watch-jump-test",
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

const write = (controller: TerminalController, text: string) =>
  new Promise<void>((resolve) => controller.term.write(text, resolve));

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("watch-mark jumps", () => {
  const visible = (controller: TerminalController, line: number) => {
    const buf = controller.term.buffer.active;
    return line >= buf.viewportY && line < buf.viewportY + controller.term.rows;
  };

  it("walks the marked rows and stops at both ends", async () => {
    const controller = createController();
    const filler = (label: string) => label.repeat(20).replace(/(.{10})/g, "$1\r\n");
    // A buffer taller than the screen, so a jump really scrolls.
    await write(controller, filler("filler-one-"));
    await write(controller, "ERROR first\r\n");
    await write(controller, filler("filler-two-"));
    await write(controller, "warning second\r\n");
    await write(controller, filler("filler-end-"));

    const marks = controller.watchMarkLines();
    expect(marks.length, "two marked rows").toBe(2);
    expect(marks[0]).toBeLessThan(marks[1]);

    // "Previous" starts from the cursor at the bottom: the most recent mark.
    expect(controller.jumpToWatchMark(-1)).toBe(true);
    expect(visible(controller, marks[1]), "lands on the later mark").toBe(true);
    expect(controller.jumpToWatchMark(-1)).toBe(true);
    expect(visible(controller, marks[0]), "lands on the earlier mark").toBe(true);
    expect(controller.jumpToWatchMark(-1), "nothing earlier").toBe(false);
    expect(controller.jumpToWatchMark(1)).toBe(true);
    expect(visible(controller, marks[1]), "next walks back down").toBe(true);
    expect(controller.jumpToWatchMark(1), "nothing later").toBe(false);
  });

  it("reports nothing to land on when the buffer has no marks", async () => {
    const controller = createController();
    await write(controller, "clean run\r\n");
    expect(controller.watchMarkLines()).toEqual([]);
    expect(controller.jumpToWatchMark(1)).toBe(false);
    expect(controller.jumpToWatchMark(-1)).toBe(false);
  });
});
