import { describe, expect, it } from "vitest";

import { senderTargetIds } from "./components/panels/useSenderSend";
import type { Tab } from "./store";

const tab = (id: string, state: Tab["state"], kind: "ssh" | "sftp" = "ssh"): Tab =>
  ({
    info: { id, name: id, kind, address: id, color: null },
    state,
  }) as unknown as Tab;

// A line typed into a session that is still in its handshake lands in the
// banner or a password prompt, and a closed one only answers with the
// backend's error. Only a connected terminal is a target.
describe("senderTargetIds", () => {
  it("skips a current tab that is still connecting", () => {
    expect(senderTargetIds([tab("a", "connecting")], "a", "current")).toEqual([]);
  });

  it("skips a current tab that has closed", () => {
    expect(senderTargetIds([tab("a", "closed")], "a", "current")).toEqual([]);
  });

  it("takes the current tab once it is connected", () => {
    expect(senderTargetIds([tab("a", "connected")], "a", "current")).toEqual(["a"]);
  });

  it("never targets a file session", () => {
    expect(senderTargetIds([tab("f", "connected", "sftp")], "f", "current")).toEqual([]);
    expect(senderTargetIds([tab("f", "connected", "sftp")], "f", "all")).toEqual([]);
  });

  it("has nothing to send to without an active tab", () => {
    expect(senderTargetIds([tab("a", "connected")], null, "current")).toEqual([]);
  });

  it("broadcasts only to connected terminals, in strip order", () => {
    const tabs = [
      tab("a", "connected"),
      tab("b", "connecting"),
      tab("c", "connected"),
      tab("d", "connected", "sftp"),
      tab("e", "closed"),
    ];
    expect(senderTargetIds(tabs, "b", "all")).toEqual(["a", "c"]);
  });
});
