import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { setCurrentLanguage } from "./i18n";
import { getSchedule, startSchedule, stopSchedule } from "./senderSchedule";
import { useStore } from "./store";

vi.mock("./api", () => ({ writeSession: vi.fn(async () => undefined) }));

const everySecond = (overrides: { times?: number; target?: "all" | "current" } = {}) => ({
  text: "date",
  ending: "lf" as const,
  target: "all" as const,
  sessionId: null,
  every: 1,
  times: 1,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({ tabs: [], status: "" });
});

afterEach(() => {
  stopSchedule();
  setCurrentLanguage("en");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Sender repeat schedule", () => {
  it("does not report a repeat that never reached a session", async () => {
    // Nothing is connected: the tick has no target to write to, so it must not
    // count as one of the requested repeats (the old implementation counted it,
    // then printed "repeated the command N times, done" without sending).
    expect(startSchedule(everySecond())).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(api.writeSession).not.toHaveBeenCalled();
    expect(getSchedule()).not.toBeNull();
    expect(useStore.getState().status).not.toContain("done");
  });

  it("counts a tick only when a connected session received the command", async () => {
    useStore.setState({
      tabs: [{ info: { id: "s1", kind: "ssh" }, state: "connected" } as never],
    });
    expect(startSchedule(everySecond({ times: 2 }))).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    expect(getSchedule()?.sent).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeSession).toHaveBeenCalledTimes(2);
    expect(getSchedule()).toBeNull();
  });

  it("writes both repeat statuses in the interface language", async () => {
    setCurrentLanguage("zh-CN");
    useStore.setState({
      tabs: [{ info: { id: "s1", kind: "ssh" }, state: "connected" } as never],
    });
    expect(startSchedule(everySecond())).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(useStore.getState().status).toBe("发送器：命令已重复 1 次，完成");
  });
});
