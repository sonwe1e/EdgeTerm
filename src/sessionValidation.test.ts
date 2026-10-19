import { describe, expect, it } from "vitest";

import { invalidField, validateProfile } from "./sessionValidation";
import type { SessionProfile } from "./types";

const ssh = (overrides: Partial<SessionProfile> = {}): SessionProfile => ({
  id: "web-prod-01",
  name: "web-prod-01",
  kind: "ssh",
  host: "10.20.4.17",
  port: 22,
  ...overrides,
});

describe("validateProfile", () => {
  it("accepts a complete remote profile", () => {
    expect(validateProfile(ssh())).toBeNull();
  });

  it("refuses a remote profile without a host", () => {
    expect(validateProfile(ssh({ host: "" }))).toContain("host");
    expect(validateProfile(ssh({ host: "   " }))).toContain("host");
    expect(validateProfile(ssh({ host: null }))).toContain("host");
  });

  it("refuses a port outside 1..65535", () => {
    expect(validateProfile(ssh({ port: 0 }))).toContain("port");
    expect(validateProfile(ssh({ port: 65536 }))).toContain("port");
    expect(validateProfile(ssh({ port: 22.5 }))).toContain("port");
  });

  it("keeps the serial and local rules", () => {
    expect(validateProfile({ id: "console", name: "console", kind: "serial", baudRate: 9600 })).toBeNull();
    expect(validateProfile({ id: "console", name: "console", kind: "serial" })).toContain("Baud");
    expect(validateProfile({ id: "shell", name: "shell", kind: "local" })).toBeNull();
  });

  it("still checks a locale before anything else", () => {
    expect(validateProfile(ssh({ locale: "en_US.UTF-8" }))).toBeNull();
    expect(validateProfile(ssh({ locale: "not a locale" }))).toContain("Locale");
  });
});

describe("invalidField", () => {
  it("names the field the message is about, in the same order", () => {
    expect(invalidField(ssh())).toBeNull();
    expect(invalidField(ssh({ host: "   " }))).toBe("host");
    expect(invalidField(ssh({ port: 70000 }))).toBe("port");
    expect(invalidField(ssh({ locale: "not a locale" }))).toBe("locale");
    expect(invalidField({ id: "console", name: "console", kind: "serial" })).toBe(
      "baudRate",
    );
    expect(invalidField({ id: "shell", name: "shell", kind: "local" })).toBeNull();
  });
});
