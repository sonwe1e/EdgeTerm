import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "hidden-test",
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
    1000,
  );
  controllers.push(controller);
  return { controller };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

const write = (controller: TerminalController, text: string) =>
  new Promise<void>((resolve) => controller.term.write(text, resolve));

const IP_COLOR = "#5fd7c0";

function fg(controller: TerminalController, row: number, col: number) {
  const cell = controller.term.buffer.active.getLine(row)?.getCell(col);
  if (!cell) throw new Error(`no cell at ${row}:${col}`);
  return cell.isFgRGB() ? `#${cell.getFgColor().toString(16).padStart(6, "0")}` : null;
}

describe("a terminal that is not on screen", () => {
  it("leaves the viewport unpainted while hidden and paints it on show", async () => {
    const { controller } = createController();
    await write(controller, "host 10.0.0.1 up\r\n");
    // Hidden: no paint pass may run. A background agent tab that redraws a
    // spinner every frame would otherwise cost a viewport scan per frame.
    expect(fg(controller, 0, 5)).toBeNull();

    controller.setVisible(true);
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);
  });

  it("keeps painting rows written while it is on screen", async () => {
    const { controller } = createController();
    controller.setVisible(true);
    await write(controller, "host 10.0.0.1 up\r\n");
    expect(fg(controller, 0, 5)).toBe(IP_COLOR);

    controller.setVisible(false);
    await write(controller, "peer 10.0.0.2 up\r\n");
    expect(fg(controller, 1, 5)).toBeNull();
    controller.setVisible(true);
    expect(fg(controller, 1, 5)).toBe(IP_COLOR);
  });
});
