import { describe, expect, it } from "vitest";
import { parseQuickConnect, quickConnectLabel, quickConnectProfile } from "./quickConnect";
import type { SessionProfile } from "./types";

const base = {
  id: "p1",
  name: "saved",
  kind: "ssh",
  host: "",
  port: 22,
  username: "default",
} as unknown as SessionProfile;

describe("parseQuickConnect", () => {
  it("reads host, user and port where they are written", () => {
    expect(parseQuickConnect("example.com")).toEqual({
      username: null,
      host: "example.com",
      port: null,
    });
    expect(parseQuickConnect("root@10.0.0.5")).toEqual({
      username: "root",
      host: "10.0.0.5",
      port: null,
    });
    expect(parseQuickConnect("deploy@build-01.lab:2222")).toEqual({
      username: "deploy",
      host: "build-01.lab",
      port: 2222,
    });
    expect(parseQuickConnect("[::1]:2222")).toEqual({ username: null, host: "[::1]", port: 2222 });
    expect(parseQuickConnect("[::1]")).toEqual({ username: null, host: "[::1]", port: null });
  });

  it("takes the ssh:// scheme a pasted link arrives with", () => {
    expect(parseQuickConnect("ssh://root@example.com:2200")).toEqual({
      username: "root",
      host: "example.com",
      port: 2200,
    });
    expect(parseQuickConnect("SSH://example.com")).toEqual({
      username: null,
      host: "example.com",
      port: null,
    });
  });

  it("refuses anything that is a search phrase rather than a target", () => {
    expect(parseQuickConnect("")).toBeNull();
    expect(parseQuickConnect("display settings")).toBeNull();
    expect(parseQuickConnect("@host")).toBeNull();
    expect(parseQuickConnect("user@")).toBeNull();
    expect(parseQuickConnect("host:0")).toBeNull();
    expect(parseQuickConnect("host:99999")).toBeNull();
    expect(parseQuickConnect("host:22x")).toBeNull();
    expect(parseQuickConnect("bad host.com")).toBeNull();
    // A single word is a command name or a phrase, not a machine.
    expect(parseQuickConnect("ssh")).toBeNull();
    expect(parseQuickConnect("zzzz")).toBeNull();
    // IPv6 without brackets leaves the port ambiguous.
    expect(parseQuickConnect("::1")).toBeNull();
    expect(parseQuickConnect("[::1]x")).toBeNull();
  });
});

describe("quick connect targets", () => {
  it("names the tab with the parts the reader typed", () => {
    expect(quickConnectLabel({ username: "root", host: "h", port: 22 })).toBe("root@h:22");
    expect(quickConnectLabel({ username: null, host: "h", port: null })).toBe("h");
  });

  it("fills an unsaved SSH profile from the target", () => {
    const profile = quickConnectProfile({ username: "root", host: "h", port: 2200 }, base);
    expect(profile).toMatchObject({
      id: "",
      name: "root@h:2200",
      kind: "ssh",
      host: "h",
      port: 2200,
      username: "root",
    });
  });

  it("keeps the defaults the text did not name", () => {
    const profile = quickConnectProfile({ username: null, host: "h", port: null }, base);
    expect(profile.port).toBe(22);
    expect(profile.username).toBe("default");
  });
});
