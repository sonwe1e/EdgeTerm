import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionProfile } from "./types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ status: "connected", info: {} })) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage?: (data: ArrayBuffer) => void;
  },
}));
import { closeSession, openSession } from "./api";

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(async () => {
  await closeSession("output-test");
  ipc.invoke.mockClear();
});

function opened() {
  const call = ipc.invoke.mock.calls.find((args) => (args as unknown[])[0] === "open_session");
  return (call as unknown[])[1] as {
    outputToken: string;
    onOutput: { onmessage(data: ArrayBuffer): void };
  };
}

describe("raw output IPC", () => {
  it("passes automatic reuse and preserves an explicit duplicate source", async () => {
    await openSession({} as SessionProfile, "output-test", () => {}, "source-tab", false);
    const args = ipc.invoke.mock.calls.find(
      (call) => (call as unknown[])[0] === "open_session",
    ) as unknown[];
    expect(args[1]).toMatchObject({ autoReuse: false, reuseSessionId: "source-tab" });
  });
  it("keeps acknowledgements working if closing the backend fails", async () => {
    let consume!: () => void;
    await openSession({} as SessionProfile, "output-test", (_data, done) => {
      consume = done;
    });
    const { outputToken, onOutput } = opened();
    onOutput.onmessage(new ArrayBuffer(8));
    ipc.invoke.mockRejectedValueOnce(new Error("close failed"));
    await expect(closeSession("output-test")).rejects.toThrow("close failed");
    consume();
    await tick();
    expect(ipc.invoke).toHaveBeenLastCalledWith("acknowledge_session_output", {
      token: outputToken,
      consumed: 8,
    });
  });

  it("acknowledges the raw byte count only after the consumer completes", async () => {
    let consume!: () => void;
    const receive = vi.fn((_bytes: Uint8Array, done: () => void) => {
      consume = done;
    });
    await openSession({} as SessionProfile, "output-test", receive);
    const { outputToken, onOutput } = opened();
    onOutput.onmessage(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer);
    await tick();
    expect(receive.mock.calls[0][0]).toEqual(Uint8Array.of(0xc4, 0xe3, 0xba, 0xc3));
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    consume();
    await tick();
    expect(ipc.invoke).toHaveBeenLastCalledWith("acknowledge_session_output", {
      token: outputToken,
      consumed: 4,
    });
  });

  it("ignores old output and old completions after reconnecting the same tab", async () => {
    const done: (() => void)[] = [];
    await openSession({} as SessionProfile, "output-test", (_data, ack) => done.push(ack));
    const previous = opened();
    previous.onOutput.onmessage(new ArrayBuffer(100));
    ipc.invoke.mockClear();
    const currentReceive = vi.fn((_data: Uint8Array, ack: () => void) => ack());
    await openSession({} as SessionProfile, "output-test", currentReceive);
    const current = opened();
    expect(current.outputToken).not.toBe(previous.outputToken);
    previous.onOutput.onmessage(new ArrayBuffer(100));
    done[0]();
    current.onOutput.onmessage(new ArrayBuffer(20));
    await tick();
    expect(currentReceive).toHaveBeenCalledTimes(1);
    expect(ipc.invoke).toHaveBeenLastCalledWith("acknowledge_session_output", {
      token: current.outputToken,
      consumed: 20,
    });
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
  });
});
