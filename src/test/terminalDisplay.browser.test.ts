import { afterEach, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { createElement as h } from "react";
import { SessionPane } from "../components/TerminalPane";
import type { Tab } from "../store";
import { TerminalController } from "../terminal";
import {
  disposeController,
  getController,
  isWebglEnabled,
  setWebglEnabled,
} from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

const live: { controller: TerminalController; slot: HTMLElement }[] = [];
const previousGpu = isWebglEnabled();
const session = cdp() as unknown as {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

async function scale(deviceScaleFactor: number) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 800,
    deviceScaleFactor,
    mobile: false,
  });
  await expect.poll(() => window.devicePixelRatio).toBe(deviceScaleFactor);
  // CDP changes DPR without delivering the OS window-resize event to the
  // test iframe. Use xterm's real window-event entry, not its private handler.
  window.dispatchEvent(new Event("resize"));
  await wait(200);
}

function make(gpu: boolean) {
  setWebglEnabled(gpu);
  const slot = document.createElement("div");
  slot.className = "pane-slot";
  slot.style.cssText = "position:absolute;left:0;top:0;width:900px;height:480px";
  const host = document.createElement("div");
  host.className = "term-pane";
  slot.append(host);
  document.body.append(slot);
  const controller = new TerminalController(
    `display-${live.length}`,
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
    20000,
  );
  live.push({ controller, slot });
  controller.attach(host);
  controller.setVisible(true);
  controller.fit(true);
  return { controller, slot };
}

afterEach(async () => {
  await browserAfterEach();
  vi.restoreAllMocks();
  for (const { controller, slot } of live.splice(0)) {
    if (getController(controller.sessionId) === controller) {
      disposeController(controller.sessionId);
    } else {
      controller.dispose();
    }
    slot.remove();
  }
  setWebglEnabled(previousGpu);
  await session.send("Emulation.clearDeviceMetricsOverride");
});

it("measures a sidebar-size change once when the terminal grid has not changed", async () => {
  await scale(1);
  setWebglEnabled(false);
  const id = "sidebar-resize-fixture";
  const tab: Tab = {
    info: {
      id,
      profileId: null,
      name: id,
      kind: "local",
      protocol: "local",
      address: "",
      color: null,
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: id, kind: "local" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "main",
  };
  const pane = mount(
    h(SessionPane, {
      tab,
      visible: true,
      focused: false,
      style: { left: 0, top: 0, width: 900, height: 480 },
    }),
  );
  await expect.poll(() => getController(id)).toBeDefined();
  const controller = getController(id)!;
  live.push({ controller, slot: pane.container });
  await wait(250);
  const grid = [controller.term.cols, controller.term.rows];
  const propose = vi.spyOn(controller.fitAddon, "proposeDimensions");
  pane.container.querySelector<HTMLElement>(".pane-slot")!.style.width = "900.25px";
  await twoFrames();
  expect(propose).toHaveBeenCalledOnce();
  expect([controller.term.cols, controller.term.rows]).toEqual(grid);
});

it.each([true, false])(
  "refits visible terminals when only the display pixel ratio changes (GPU %s)",
  async (gpu) => {
    await scale(1);
    const { controller, slot } = make(gpu);
    await new Promise<void>((resolve) =>
      controller.term.write("scale-check\r\n".repeat(300), resolve),
    );
    await wait(250);
    if (gpu) expect(slot.querySelector(".xterm-screen > canvas")).not.toBeNull();
    for (const dpr of [1.25, 1.5, 2, 1]) {
      await scale(dpr);
      const proposal = controller.fitAddon.proposeDimensions()!;
      expect(
        { cols: controller.term.cols, rows: controller.term.rows },
        `fit at DPR ${dpr}`,
      ).toEqual(proposal);
      expect(controller.term.buffer.normal.getLine(0)?.translateToString(true)).toContain(
        "scale-check",
      );
      const screen = slot.querySelector<HTMLElement>(".xterm-screen")!;
      const gutter = slot.querySelector<HTMLElement>(".term-gutter")!;
      expect(
        Math.abs(
          parseFloat(gutter.style.getPropertyValue("--gutter-cell")) -
            screen.clientHeight / controller.term.rows,
        ),
      ).toBeLessThan(0.1);
      if (dpr === 1.25) {
        await page.screenshot({
          path: `../../artifacts/ui-display/dpr125-${gpu ? "gpu" : "dom"}.png`,
        });
      }
    }
  },
);

it("coalesces display notifications and drops queued work on hide and dispose", async () => {
  await scale(1);
  const { controller, slot } = make(true);
  await wait(200);
  const service = (
    controller.term as unknown as {
      _core: {
        _renderService: {
          handleDevicePixelRatioChange(): void;
          _renderer: { value: { handleDevicePixelRatioChange(): void } };
        };
      };
    }
  )._core._renderService;
  const resize = vi.spyOn(service._renderer.value, "handleDevicePixelRatioChange");
  service.handleDevicePixelRatioChange();
  service.handleDevicePixelRatioChange();
  service.handleDevicePixelRatioChange();
  await twoFrames();
  expect(resize).toHaveBeenCalledOnce();
  resize.mockClear();
  service.handleDevicePixelRatioChange();
  slot.classList.add("is-hidden");
  controller.setVisible(false);
  await twoFrames();
  expect(resize).not.toHaveBeenCalled();
  slot.classList.remove("is-hidden");
  controller.setVisible(true);
  controller.fit(true);
  expect(resize).toHaveBeenCalledOnce();
  resize.mockClear();
  service.handleDevicePixelRatioChange();
  controller.dispose();
  live.pop();
  slot.remove();
  await twoFrames();
  expect(resize).not.toHaveBeenCalled();
});

it("defers hidden GPU display resizes until the terminal is shown", async () => {
  await scale(1);
  const { controller, slot } = make(true);
  await twoFrames();
  const renderer = (
    controller.term as unknown as {
      _core: { _renderService: { _renderer: { value: { handleDevicePixelRatioChange(): void } } } };
    }
  )._core._renderService._renderer.value;
  const resize = vi.spyOn(renderer, "handleDevicePixelRatioChange");
  slot.classList.add("is-hidden");
  controller.setVisible(false);
  await twoFrames();
  const canvas = slot.querySelector<HTMLCanvasElement>(".xterm-screen > canvas")!;
  const width = canvas.width;
  await scale(1.5);
  await scale(2);
  expect(resize).not.toHaveBeenCalled();
  expect(canvas.width).toBe(width);
  slot.classList.remove("is-hidden");
  controller.setVisible(true);
  controller.fit(true);
  await twoFrames();
  expect(resize).toHaveBeenCalledOnce();
  expect(canvas.width).toBeGreaterThan(width);
});
