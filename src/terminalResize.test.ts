import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
async function fixture(lines = 0) {
  const onResize = vi.fn();
  const controller = new TerminalController(
    "resize-audit",
    {
      onData() {},
      onResize,
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    2000,
  );
  controllers.push(controller);
  if (lines)
    await new Promise<void>((done) => controller.term.write("line\r\n".repeat(lines), done));
  const state = controller as unknown as {
    host: HTMLElement;
    visible: boolean;
    fitAddon: { proposeDimensions(): { cols: number; rows: number }; fit(): void };
  };
  state.host = document.createElement("div");
  Object.defineProperty(state.host, "clientWidth", { value: 800 });
  state.visible = true;
  let dimensions = { cols: controller.term.cols, rows: controller.term.rows };
  // jsdom has no layout; mock only measurement, retaining xterm's real resize
  // and onResize event (the same event used to resize the backend PTY).
  vi.spyOn(state.fitAddon, "proposeDimensions").mockImplementation(() => dimensions);
  vi.spyOn(state.fitAddon, "fit").mockImplementation(() =>
    controller.term.resize(dimensions.cols, dimensions.rows),
  );
  vi.useFakeTimers();
  return {
    controller,
    onResize,
    propose: (cols: number, rows: number) => {
      dimensions = { cols, rows };
    },
  };
}

afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});

describe("resize policy at the terminal boundary", () => {
  it("applies successive width changes immediately below 200 normal-buffer lines", async () => {
    const { controller: c, propose, onResize } = await fixture();
    propose(90, 20);
    c.fit();
    propose(100, 22);
    c.scheduleFit();
    expect([c.term.cols, c.term.rows]).toEqual([100, 22]);
    expect(onResize).toHaveBeenLastCalledWith(100, 22);
  });

  it.each([8, 16, 40, 80])(
    "applies rows throughout a diagonal drag and settles only columns (%i ms)",
    async (interval) => {
      const { controller: c, propose, onResize } = await fixture(250);
      const cols = c.term.cols;
      for (let n = 0; n < 8; n++) {
        propose(90 + n, 20 + n);
        c.scheduleFit();
        expect([c.term.cols, c.term.rows]).toEqual([cols, 20 + n]);
        vi.advanceTimersByTime(interval);
      }
      vi.advanceTimersByTime(100);
      expect([c.term.cols, c.term.rows]).toEqual([97, 27]);
      expect(onResize.mock.calls.filter(([width]) => width !== cols)).toEqual([[97, 27]]);
    },
  );

  it("cancels a pending width change when hidden, then fits on show", async () => {
    const { controller: c, propose } = await fixture(250);
    const before = [c.term.cols, c.term.rows];
    propose(95, c.term.rows);
    c.fit();
    c.setVisible(false);
    propose(105, 30);
    c.scheduleFit();
    vi.advanceTimersByTime(500);
    expect([c.term.cols, c.term.rows]).toEqual(before);
    c.setVisible(true);
    c.fit(true);
    expect([c.term.cols, c.term.rows]).toEqual([105, 30]);
  });

  it.each([199, 200])(
    "switches column policy at exactly %i normal-buffer lines",
    async (length) => {
      const { controller: c, propose } = await fixture(length - 1);
      expect(c.term.buffer.normal.length).toBe(length);
      const oldCols = c.term.cols;
      propose(105, c.term.rows);
      c.fit();
      expect(c.term.cols).toBe(length < 200 ? 105 : oldCols);
      vi.advanceTimersByTime(100);
      expect(c.term.cols).toBe(105);
    },
  );

  it("applies row-only changes and cancels a queued width when dragged back", async () => {
    const { controller: c, propose, onResize } = await fixture(250);
    const cols = c.term.cols;
    propose(cols, 30);
    c.fit();
    expect(onResize).toHaveBeenLastCalledWith(cols, 30);
    propose(cols + 10, 30);
    c.fit();
    propose(cols, 35);
    c.fit();
    expect(onResize).toHaveBeenLastCalledWith(cols, 35);
    vi.advanceTimersByTime(500);
    expect(c.term.cols).toBe(cols);
    expect(onResize.mock.calls.every(([width]) => width === cols)).toBe(true);
  });

  it("drops deferred work on dispose", async () => {
    const { controller: c, propose, onResize } = await fixture(250);
    propose(110, c.term.rows);
    c.fit();
    c.dispose();
    controllers.pop();
    onResize.mockClear();
    c.scheduleFit();
    vi.advanceTimersByTime(500);
    expect(onResize).not.toHaveBeenCalled();
  });
});
