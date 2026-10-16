import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  addons: [] as { dispose: ReturnType<typeof vi.fn>; lose(): void }[],
}));
vi.mock("./terminalRegistry", () => ({ isWebglEnabled: () => true }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    private loss = () => {};
    constructor() {
      fixtures.addons.push(this);
    }
    onContextLoss(callback: () => void) {
      this.loss = callback;
    }
    lose() {
      this.loss();
    }
  },
}));

import { TerminalGpuRenderer } from "./terminalGpuRenderer";

const renderers: TerminalGpuRenderer[] = [];
function renderer() {
  const loadAddon = vi.fn();
  const context = {
    term: { loadAddon } as unknown as Terminal,
    host: document.createElement("div"),
    disposed: false,
    visible: true,
    sessionId: "gpu-fixture",
  };
  const gpu = new TerminalGpuRenderer(context);
  renderers.push(gpu);
  gpu.refreshWebgl();
  return { gpu, context, loadAddon };
}
afterEach(() => {
  renderers.splice(0).forEach((r) => r.dispose());
  fixtures.addons.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps six GPU holders and evicts the least recently promoted renderer", () => {
  const holders = Array.from({ length: 6 }, renderer);
  holders[0].gpu.refreshWebgl();
  renderer();
  expect(fixtures.addons[0].dispose).not.toHaveBeenCalled();
  expect(fixtures.addons[1].dispose).toHaveBeenCalledOnce();
  expect(holders[0].loadAddon).toHaveBeenCalledOnce();
});

it("limits context-loss recovery to three delayed attempts per minute", () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { loadAddon } = renderer();
  for (let i = 0; i < 4; i++) {
    fixtures.addons[fixtures.addons.length - 1].lose();
    vi.advanceTimersByTime(1999);
    expect(loadAddon).toHaveBeenCalledTimes(Math.min(i + 1, 4));
    vi.advanceTimersByTime(1);
  }
  expect(loadAddon).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels the renderer's recovery timer when its owner disposes it", () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { gpu, context, loadAddon } = renderer();
  fixtures.addons[0].lose();
  context.disposed = true;
  gpu.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(loadAddon).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
