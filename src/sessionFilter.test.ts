import { describe, expect, it } from "vitest";

import { groupPathMatches, sessionMatchesFilter } from "./sessionFilter";

const lab = { name: "Lab box", host: "10.0.0.5", username: "root", port: 2222 };
const serial = { name: "Console", portName: "COM3" };

describe("sessionMatchesFilter", () => {
  it("shows everything for an empty filter", () => {
    expect(sessionMatchesFilter(lab, "")).toBe(true);
    expect(sessionMatchesFilter(lab, "   ")).toBe(true);
  });

  it("still matches the name, ignoring case", () => {
    expect(sessionMatchesFilter(lab, "lab")).toBe(true);
    expect(sessionMatchesFilter(lab, "BOX")).toBe(true);
    expect(sessionMatchesFilter(lab, "box")).toBe(true);
  });

  it("matches the host, the user and the pair", () => {
    expect(sessionMatchesFilter(lab, "10.0.0")).toBe(true);
    expect(sessionMatchesFilter(lab, "root@10")).toBe(true);
    expect(sessionMatchesFilter(lab, "root")).toBe(true);
  });

  it("matches a port or a serial port name", () => {
    expect(sessionMatchesFilter(lab, "2222")).toBe(true);
    expect(sessionMatchesFilter(serial, "com3")).toBe(true);
  });

  it("rejects when no part of the connection contains the text", () => {
    expect(sessionMatchesFilter(lab, "stage")).toBe(false);
    expect(sessionMatchesFilter(serial, "10.")).toBe(false);
  });
});

describe("groupPathMatches", () => {
  it("finds a session by a group on its path", () => {
    expect(groupPathMatches(["prod", "eu"], "prod")).toBe(true);
    expect(groupPathMatches(["prod", "eu"], "eu")).toBe(true);
    expect(groupPathMatches(["prod", "eu"], "PROD")).toBe(true);
  });

  it("returns false for an empty filter or a path that does not match", () => {
    expect(groupPathMatches(["prod"], "")).toBe(false);
    expect(groupPathMatches([], "prod")).toBe(false);
    expect(groupPathMatches(["prod"], "stage")).toBe(false);
  });
});
