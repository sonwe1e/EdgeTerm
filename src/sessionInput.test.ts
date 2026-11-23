import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  writeSession: vi.fn(async () => undefined),
}));

import * as api from "./api";
import { sendSessionInput } from "./sessionInput";
import { clearPendingInput, takePendingInput } from "./pendingInput";
import { useStore, type Tab } from "./store";
import type { SessionKind, SessionState } from "./types";

const writeSession = vi.mocked(api.writeSession);

const tab = (id: string, kind: SessionKind, state: SessionState = "connected") =>
  ({ info: { id, kind }, state }) as unknown as Tab;

const fixture = () => {
  useStore.setState({
    tabs: [
      tab("src", "ssh"),
      tab("peer", "ssh"),
      tab("file", "sftp"),
      tab("offline", " ssh" as SessionKind, "closed"),
    ],
    activeId: "src",
    broadcastInput: false,
  });
};

beforeEach(() => {
  writeSession.mockClear();
  fixture();
});

afterEach(() => {
  clearPendingInput("src");
  clearPendingInput("peer");
  useStore.setState({ tabs: [], activeId: null, broadcastInput: false });
});

describe("sendSessionInput", () => {
  it("writes the focused session only when synchronized input is off", () => {
    sendSessionInput("src", "ls");
    expect(writeSession).toHaveBeenCalledTimes(1);
    expect(writeSession).toHaveBeenCalledWith("src", "ls");
  });

  it("writes every connected shell when synchronized input is on", () => {
    useStore.setState({ broadcastInput: true });
    sendSessionInput("src", "ls");
    expect(writeSession.mock.calls.map(([id]) => id)).toEqual(["src", "peer"]);
    for (const [, data] of writeSession.mock.calls) expect(data).toBe("ls");
  });

  it("holds input typed during the handshake and broadcasts nothing yet", () => {
    useStore.setState({
      tabs: [tab("src", "ssh", "connecting"), tab("peer", "ssh")],
      broadcastInput: true,
    });
    sendSessionInput("src", "early");
    expect(writeSession).not.toHaveBeenCalled();
    expect(takePendingInput("src")).toBe("early");
  });

  it("does not broadcast to a file session or a closed shell", () => {
    useStore.setState({
      tabs: [
        tab("src", "ssh"),
        tab("peer", "ssh"),
        tab("file", "sftp"),
        tab("offline", "ssh", "closed"),
      ],
      broadcastInput: true,
    });
    sendSessionInput("src", "x");
    expect(writeSession.mock.calls.map(([id]) => id)).toEqual(["src", "peer"]);
  });
});
