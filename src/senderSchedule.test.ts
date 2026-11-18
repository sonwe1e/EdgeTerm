import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { setCurrentLanguage } from "./i18n";
import { getSchedule, startSchedule, stopSchedule } from "./senderSchedule";
import { useStore } from "./store";

vi.mock("./api", () => ({ writeSession: vi.fn(async () => undefined) }));

const everySecond = (
  overrides: {
    times?: number;
    target?: "all" | "current";
    text?: string;
    sessionId?: string | null;
  } = {},
) => ({
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

  it("stops for good when the session it was repeating into is closed", async () => {
    useStore.setState({
      tabs: [{ info: { id: "s1", kind: "ssh" }, state: "connected" } as never],
    });
    const spec = everySecond({ target: "current", times: 0 });
    expect(startSchedule({ ...spec, sessionId: "s1" })).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeSession).toHaveBeenCalledTimes(1);

    // The tab is closed: the schedule stops instead of ticking into nothing.
    useStore.setState({ tabs: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSchedule()).toBeNull();
    expect(useStore.getState().status).toContain("stopped");

    // Nothing keeps firing afterwards.
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
  });

  it("stops the timer as well as the state", async () => {
    useStore.setState({
      tabs: [{ info: { id: "s1", kind: "ssh" }, state: "connected" } as never],
    });
    expect(startSchedule(everySecond({ times: 0 }))).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeSession).toHaveBeenCalledTimes(1);

    stopSchedule();
    expect(getSchedule()).toBeNull();
    // The pending timer is cleared, not left to fire and return early: a leaked
    // timer keeps the page awake and is invisible to a write count.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a plan it cannot run and leaves the running one alone", async () => {
    useStore.setState({
      tabs: [{ info: { id: "s1", kind: "ssh" }, state: "connected" } as never],
    });
    expect(startSchedule(everySecond({ times: 0 }))).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeSession).toHaveBeenCalledTimes(1);

    // An empty box has no line to send; whitespace is a real command (a bare
    // Enter for a here-document, #115) and is allowed on purpose.
    expect(startSchedule(everySecond({ text: "" }))).toContain("command");
    expect(getSchedule(), "the running plan is untouched").not.toBeNull();
    expect(startSchedule(everySecond({ target: "current", sessionId: null }))).toContain("session");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeSession).toHaveBeenCalledTimes(2);
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
