import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readMonitorSettings, saveMonitorSettings } from "./monitorSettings";
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("says whether the value reached storage", () => {
  expect(saveMonitorSettings({ enabled: false, intervalSeconds: 5 })).toBe(true);
  // A browser with storage blocked or full keeps the value in memory only; the
  // caller has to be able to tell, or the setting silently reverts.
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  expect(saveMonitorSettings({ enabled: true, intervalSeconds: 5 })).toBe(false);
});
it("preserves legitimate fields and rejects damaged intervals", () => {
  expect(readMonitorSettings()).toEqual({ enabled: true, intervalSeconds: 2 });
  localStorage.setItem(
    "edgeterm.resource-monitor",
    '{"enabled":false,"intervalSeconds":999,"unknown":1}',
  );
  expect(readMonitorSettings()).toEqual({ enabled: false, intervalSeconds: 2 });
  saveMonitorSettings({ enabled: true, intervalSeconds: 30 });
  expect(readMonitorSettings().intervalSeconds).toBe(30);
  localStorage.setItem("edgeterm.resource-monitor", "{broken");
  expect(readMonitorSettings().intervalSeconds).toBe(2);
});
