import { describe, expect, it } from "vitest";

import { SSH_URI_REGEX } from "./terminalShared";

/**
 * The regex the terminal hands the web-links addon for `ssh://` links. The
 * addon clones it with the `g` flag and drops matches `new URL` rejects, so
 * these cases pin what reaches that filter, not the final underline.
 */
const matches = (line: string): string[] => {
  const found: string[] = [];
  for (const match of line.matchAll(new RegExp(SSH_URI_REGEX.source, "gi"))) found.push(match[0]);
  return found;
};

describe("SSH_URI_REGEX", () => {
  it("finds the addresses a ticket or a script prints", () => {
    expect(matches("connect: ssh://root@10.0.0.5:2222 now")).toEqual(["ssh://root@10.0.0.5:2222"]);
    expect(matches("ssh://example.com")).toEqual(["ssh://example.com"]);
    expect(matches("SSH://build.lab:2200")).toEqual(["SSH://build.lab:2200"]);
  });

  it("stops at the characters that end an address", () => {
    expect(matches('see "ssh://example.com/x" here')).toEqual(["ssh://example.com/x"]);
    expect(matches("ssh://example.com/path?a=1&b=2")).toEqual(["ssh://example.com/path?a=1&b=2"]);
  });

  it("carries no global flag, because the addon appends its own", () => {
    // The addon builds `new RegExp(source, flags + "g")`; a regex that already
    // has `g` throws there and every link in the terminal stops working.
    expect(SSH_URI_REGEX.global).toBe(false);
    expect(SSH_URI_REGEX.ignoreCase).toBe(true);
  });

  it("leaves other schemes and bare words alone", () => {
    expect(matches("https://example.com")).toEqual([]);
    expect(matches("ssh example.com")).toEqual([]);
  });
});
