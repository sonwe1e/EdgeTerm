import { describe, expect, it } from "vitest";
import { recordingStem } from "./recordingName";

describe("recordingStem", () => {
  it("replaces the characters the backend replaces", () => {
    expect(recordingStem("db: prod")).toBe("db_ prod");
    const slashed = ["a", "b"].join(String.fromCharCode(92));
    expect(recordingStem(slashed)).toBe("a_b");
    expect(recordingStem('x*y?z"w<v>u|t')).toBe("x_y_z_w_v_u_t");
  });

  it("drops surrounding spaces and dots, which hide or vanish on Windows", () => {
    expect(recordingStem("  .hidden.  ")).toBe("hidden");
  });

  it("keeps a name that has content and caps it where the backend caps it", () => {
    expect(recordingStem("   ")).toBe("session");
    expect(recordingStem("x".repeat(80))).toBe("x".repeat(64));
  });
});
