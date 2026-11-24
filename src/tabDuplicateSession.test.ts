// A tab menu's duplicate entry only existed for live SSH tabs, where it shares
// the connection. A local shell, telnet, serial or FTP tab had no way to open
// its own profile again in place, so the menu now offers the generic dial too.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  openSession: vi.fn(async () => {}),
}));

import { duplicateSession, pendingSessionInfo } from "./actions";
import * as api from "./api";
import { useStore } from "./store";
import type { SessionProfile } from "./types";

// Only the fields the dial reads; the tab carries the rest.
const profile = (kind: SessionProfile["kind"]): SessionProfile =>
  ({ id: "p-1", name: "saved", kind }) as unknown as SessionProfile;

const addTab = (id: string, kind: SessionProfile["kind"], state: "connected" | "closed") =>
  useStore.getState().addTab(pendingSessionInfo(id, profile(kind)), profile(kind), state);

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ tabs: [] });
});

describe("duplicateSession", () => {
  it("dials the tab's own profile again for a tab without a channel to share", async () => {
    addTab("t1", "local", "connected");
    await duplicateSession("t1");
    // A profile dialled afresh: the id it was saved under travels with it.
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.openSession).mock.calls[0][0]).toMatchObject({ id: "p-1", kind: "local" });
  });

  it("leaves a live SSH tab to duplicateSshChannel", async () => {
    addTab("t2", "ssh", "connected");
    // The SSH entry shares one transport and never logs in again, so this
    // generic dial must not offer a second route to the same tab.
    expect(await duplicateSession("t2")).toBeNull();
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it("does nothing for a tab that is gone", async () => {
    expect(await duplicateSession("missing")).toBeNull();
    expect(api.openSession).not.toHaveBeenCalled();
  });
});
