import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  listCommandHistory: vi.fn(),
  recordCommand: vi.fn(async () => {}),
  deleteCommandHistory: vi.fn(async () => {}),
  clearCommandHistory: vi.fn(async () => {}),
}));

import * as api from "./api";
import type { CommandHistoryEntry } from "./api";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function pendingHistory() {
  let finish!: (entries: CommandHistoryEntry[]) => void;
  vi.mocked(api.listCommandHistory).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { commandHistory } = await import("./history");
  commandHistory.load();
  return { history: commandHistory, finish };
}

const oldEntries: CommandHistoryEntry[] = [
  { command: "git status", host: "ssh:first", count: 2, lastUsed: 1 },
  { command: "git status", host: "ssh:second", count: 1, lastUsed: 2 },
  { command: "git diff", host: "ssh:first", count: 1, lastUsed: 3 },
];

it("keeps newly recorded commands when a delayed history snapshot arrives", async () => {
  const { history, finish } = await pendingHistory();
  history.record("git log --oneline", "ssh:first");
  finish(structuredClone(oldEntries));
  await Promise.resolve();
  expect(history.suggest("git", "ssh:first").map((entry) => entry.command)).toEqual([
    "git log --oneline",
    "git diff",
    "git status",
  ]);
  expect(api.recordCommand).toHaveBeenCalledTimes(1);
});

it("does not restore a forgotten command from any host after a delayed snapshot", async () => {
  const { history, finish } = await pendingHistory();
  history.remove("git status");
  finish(structuredClone(oldEntries));
  await Promise.resolve();
  expect(history.suggest("git", "ssh:first")).toEqual([{ command: "git diff", matchStart: 0 }]);
  expect(api.deleteCommandHistory).toHaveBeenCalledTimes(1);
});

it("keeps clear and subsequent recording in order when the initial snapshot arrives late", async () => {
  const { history, finish } = await pendingHistory();
  history.record("git branch", "ssh:first");
  await history.clear();
  history.record("git log --oneline", "ssh:first");
  finish(structuredClone(oldEntries));
  await Promise.resolve();
  expect(history.suggest("git", "ssh:first")).toEqual([
    { command: "git log --oneline", matchStart: 0 },
  ]);
  expect(api.clearCommandHistory).toHaveBeenCalledTimes(1);
  expect(api.recordCommand).toHaveBeenCalledTimes(2);
});

it("keeps a newer snapshot timestamp when the snapshot already contains local records", async () => {
  const { history, finish } = await pendingHistory();
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    history.record("git status", "ssh:first");
    history.record("git status", "ssh:first");
    finish([
      { command: "git status", host: "ssh:first", count: 4, lastUsed: 200 },
      { command: "git diff", host: "ssh:first", count: 1, lastUsed: 150 },
    ]);
    await Promise.resolve();
    expect(history.suggest("git", "ssh:first").map((entry) => entry.command)).toEqual([
      "git status",
      "git diff",
    ]);
    expect(api.recordCommand).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

it("retries a failed load and accepts the backend snapshot after a failed clear", async () => {
  vi.mocked(api.listCommandHistory).mockRejectedValueOnce(new Error("backend unavailable"));
  vi.mocked(api.clearCommandHistory).mockRejectedValueOnce(new Error("clear failed"));
  const { commandHistory: history } = await import("./history");
  history.load();
  await expect(history.clear()).rejects.toThrow("clear failed");
  await Promise.resolve();
  vi.mocked(api.listCommandHistory).mockResolvedValueOnce(structuredClone(oldEntries));
  history.load();
  await Promise.resolve();
  expect(history.suggest("git", "ssh:first").map((entry) => entry.command)).toEqual([
    "git diff",
    "git status",
  ]);
  expect(api.listCommandHistory).toHaveBeenCalledTimes(2);
});
