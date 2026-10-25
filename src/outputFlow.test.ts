import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputConsumption } from "./outputFlow";

afterEach(() => vi.useRealTimers());
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("output consumption", () => {
  it("holds credit until consumed, batches callbacks and ignores duplicate completions", async () => {
    const ack = vi.fn(async () => {});
    const flow = new OutputConsumption(ack);
    const one = flow.receive(100);
    const two = flow.receive(200);
    await tick();
    expect(ack).not.toHaveBeenCalled();
    one();
    two();
    one();
    await tick();
    expect(ack.mock.calls).toEqual([[300]]);
  });

  it("never acknowledges beyond an earlier unfinished chunk", async () => {
    const ack = vi.fn(async () => {});
    const flow = new OutputConsumption(ack);
    const first = flow.receive(10);
    const second = flow.receive(20);
    second();
    await tick();
    expect(ack).not.toHaveBeenCalled();
    first();
    await tick();
    expect(ack.mock.calls).toEqual([[30]]);
  });

  it("allows only one IPC in flight and sends the latest cumulative offset next", async () => {
    let release!: () => void;
    const ack = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const flow = new OutputConsumption(ack);
    flow.receive(10)();
    await tick();
    flow.receive(20)();
    flow.receive(30)();
    await tick();
    expect(ack.mock.calls).toEqual([[10]]);
    release();
    await tick();
    expect(ack.mock.calls).toEqual([[10], [60]]);
    release();
    flow.dispose();
  });

  it("retries a failed ACK without double counting bytes", async () => {
    vi.useFakeTimers();
    const ack = vi.fn().mockRejectedValueOnce(new Error("IPC")).mockResolvedValue(undefined);
    const flow = new OutputConsumption(ack);
    flow.receive(100)();
    await tick();
    flow.receive(50)();
    await vi.advanceTimersByTimeAsync(100);
    expect(ack.mock.calls).toEqual([[100], [150]]);
    flow.dispose();
  });

  it("retires retries and pending callbacks on disconnect", async () => {
    vi.useFakeTimers();
    const ack = vi.fn().mockRejectedValue(new Error("IPC"));
    const flow = new OutputConsumption(ack);
    flow.receive(10)();
    const pending = flow.receive(20);
    await tick();
    flow.dispose();
    pending();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ack).toHaveBeenCalledTimes(1);
  });
});
