import { describe, expect, it } from "vitest";
import { DEFAULT_TASKS, summarize } from "./verify.mjs";

describe("verify", () => {
  it("runs the repository's gate in the order standards list it", () => {
    expect(DEFAULT_TASKS).toEqual(["format:check", "typecheck", "lint", "test", "test:browser"]);
  });

  it("says ok, FAILED with the code, or skipped for every task", () => {
    const text = summarize([
      { task: "format:check", status: 0, ms: 1500, ran: true },
      { task: "typecheck", status: 2, ms: 800, ran: true },
      { task: "lint", status: 1, ms: 0, ran: false },
    ]);
    expect(text).toContain("format:check   ok 1.5s");
    expect(text).toContain("typecheck      FAILED (2) 0.8s");
    expect(text).toContain("lint           skipped");
  });
});
