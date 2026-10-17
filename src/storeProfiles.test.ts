import { afterEach, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ listProfiles: vi.fn(), listSessionGroups: vi.fn() }));

import * as api from "./api";
import { useStore } from "./store";

const initial = useStore.getState();
afterEach(() => {
  useStore.setState(initial, true);
  vi.resetAllMocks();
});

it("shows a failed profile load instead of leaving startup ready or replacing rows", async () => {
  const message = "Cannot read sessions.json; restore it and restart EdgeTerm.";
  const profiles = [{ id: "shown", name: "Already shown", kind: "local" as const }];
  useStore.setState({ profiles, error: null, status: "Ready" });
  vi.mocked(api.listProfiles).mockRejectedValue({ code: "invalidInput", message });
  vi.mocked(api.listSessionGroups).mockResolvedValue([]);
  await expect(useStore.getState().loadProfiles()).resolves.toBeUndefined();
  expect(useStore.getState().profiles).toEqual(profiles);
  expect(useStore.getState().error).toBe(message);
  expect(useStore.getState().status).toBe(message);
});
