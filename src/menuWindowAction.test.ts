import { expect, it, vi } from "vitest";

import { runWindowAction } from "./menuWindowAction";

it("reports a window action the system refused", async () => {
  const report = vi.fn();
  const result = await runWindowAction(() => Promise.reject(new Error("denied by the OS")), report);

  expect(result).toBeUndefined();
  expect(report).toHaveBeenCalledTimes(1);
  expect(String(report.mock.calls[0][0])).toContain("denied by the OS");
});

it("passes a successful action through without reporting", async () => {
  const report = vi.fn();
  await expect(runWindowAction(async () => 7, report)).resolves.toBe(7);
  expect(report).not.toHaveBeenCalled();
});
