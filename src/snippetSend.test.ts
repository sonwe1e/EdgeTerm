import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ writeSession: vi.fn(async () => {}) }));

import { pendingSessionInfo } from "./actions";
import * as api from "./api";
import { sendSnippet } from "./snippetActions";
import { useStore, type Tab } from "./store";
import type { SessionKind, SessionProfile } from "./types";

const snippet = { id: "s1", name: "Logs", command: "tail -f app.log" };

/** Only the fields the send path reads; the rest are defaults. */
const shell = (id: string, state: Tab["state"] = "connected", kind: SessionKind = "ssh"): Tab => ({
  info: pendingSessionInfo(id, { id, name: id, kind } as SessionProfile),
  profile: { id, name: id, kind } as SessionProfile,
  number: 1,
  ordinal: 0,
  state,
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const status = () => useStore.getState().status;

describe("sending a saved command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      tabs: [shell("a"), shell("b"), shell("c", "connected", "sftp"), shell("d", "closed")],
      activeId: "a",
      broadcastInput: false,
      broadcastExcluded: [],
      broadcastExcludedGroups: [],
      status: "",
    });
  });

  it("writes the line to the active shell and says so", () => {
    expect(sendSnippet(snippet)).toBe(true);
    expect(api.writeSession).toHaveBeenCalledWith("a", "tail -f app.log\r");
    expect(status()).toBe("Sent: Logs");
  });

  it("says how many shells received it when synchronized input is on", () => {
    useStore.setState({ broadcastInput: true });
    sendSnippet(snippet);
    // a is the source, b is the one other connected shell; the file browser
    // and the closed tab are never targets.
    expect(status()).toBe("Sent: Logs — to 2 shells");
    expect(api.writeSession).toHaveBeenCalledWith("b", "tail -f app.log\r");
  });

  it("counts only the shells that are still checked", () => {
    useStore.setState({ broadcastInput: true, broadcastExcluded: ["b"] });
    sendSnippet(snippet);
    expect(status()).toBe("Sent: Logs");
  });

  it("refuses with a reason when the active tab is a file browser", () => {
    useStore.setState({ activeId: "c" });
    expect(sendSnippet(snippet)).toBe(false);
    expect(api.writeSession).not.toHaveBeenCalled();
    expect(status()).toContain("shell");
  });
});
