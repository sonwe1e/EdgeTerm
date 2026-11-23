import { describe, expect, it } from "vitest";
import { pushClosedTab } from "./storeTabActions";
import type { ClosedTab } from "./storeTypes";

const entry = (name: string): ClosedTab =>
  ({
    info: { id: name },
    profile: { id: "p-" + name, name },
  }) as unknown as ClosedTab;

/**
 * The bound and the order of the reopen stack. Reopening is a safety net, not
 * a session log: it must forget the oldest close rather than grow forever, and
 * it must hand back the most recent one first.
 */
describe("closed tab stack", () => {
  it("hands back the newest close first", () => {
    const stack = [entry("a"), entry("b")];
    expect(stack[stack.length - 1].profile.name).toBe("b");
  });

  it("forgets the oldest close once the bound is reached", () => {
    let stack: ClosedTab[] = [];
    for (let index = 0; index < 12; index += 1) stack = pushClosedTab(stack, entry("s" + index));
    expect(stack.length).toBe(10);
    expect(stack[0].profile.name).toBe("s2");
    expect(stack[9].profile.name).toBe("s11");
  });
});
