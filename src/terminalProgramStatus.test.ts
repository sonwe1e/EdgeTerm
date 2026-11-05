import { describe, expect, it } from "vitest";
import { TerminalProgramStatus } from "./terminalProgramStatus";

describe("OSC 7501 activity records", () => {
  it.each([
    "state=unknown",
    "app=opencode",
    "state=idle:id=",
    "state=idle:id=bad//id",
    "state=idle:id=bad id",
    `state=idle:id=${"x".repeat(33)}`,
    "state=idle:id=a/b/c/d/e/f/g/h/i",
    `state=idle:app=${"a".repeat(33)}`,
    "state=idle:app=bad/app",
    "state=idle:app=",
    "state=idle:title=not_base64",
    "state=idle:msg=/w==", // Invalid UTF-8.
    "state=idle:msg=SGVsbG8K", // Newline in decoded text.
    `state=idle:title=${btoa("a".repeat(193))}`,
    `state=idle:msg=${btoa("a".repeat(2049))}`,
    `state=idle:${"a".repeat(17)}=x`,
    `state=idle:future=${"a".repeat(4096)}`,
  ])("ignores invalid reports without overwriting working state: %s", (report) => {
    const status = new TerminalProgramStatus();
    expect(status.update("state=working")).toBe("running");
    expect(status.update(report)).toBeNull();
    expect(status.update("state=clear:id=unrelated")).toBe("running");
  });

  it("accepts whitespace, optional base64 padding, and the last repeated state", () => {
    const status = new TerminalProgramStatus();
    expect(
      status.update("state = idle : malformed : future=ok : title=5L2g5aW9 : state=working"),
    ).toBe("running");
    expect(status.update("state=idle:broken=bad!value")).toBe("idle");
  });

  it("exposes only a validated application identity and clears it with the records", () => {
    const status = new TerminalProgramStatus();
    status.update("state=idle:app=opencode");
    expect(status.app).toBe("opencode");
    expect(status.update("state=working:app=claude:id=bad//id")).toBeNull();
    expect(status.app).toBe("opencode");
    status.update("state=clear:app=opencode");
    expect(status.app).toBeNull();
    status.update("state=working:app=opencode");
    status.clear();
    expect(status.app).toBeNull();
  });

  it("clears descendants without clearing similarly named siblings", () => {
    const status = new TerminalProgramStatus();
    status.update("state=working:id=build/test");
    status.update("state=working:id=builder");
    expect(status.update("state=clear:id=build")).toBe("running");
    expect(status.update("state=clear:id=builder")).toBe("idle");
  });

  it("gives attention precedence over work and clears all records with the root", () => {
    const status = new TerminalProgramStatus();
    status.update("state=working");
    expect(status.update("state=blocked:id=permission")).toBe("complete");
    expect(status.update("state=done:id=finished")).toBe("complete");
    expect(status.update("state=error:id=failed")).toBe("complete");
    expect(status.update("state=idle")).toBe("complete");
    expect(status.update("state=clear")).toBe("idle");
  });

  it("evicts the least recently updated record when the terminal reaches its cap", () => {
    const status = new TerminalProgramStatus();
    status.update("state=working:id=old");
    status.update("state=working:id=recent");
    for (let index = 0; index < 254; index += 1) status.update(`state=idle:id=idle${index}`);
    status.update("state=working:id=recent");
    status.update("state=idle:id=new");
    // The old working record was evicted; the updated one remained until now.
    expect(status.update("state=clear:id=recent")).toBe("idle");
  });
});
