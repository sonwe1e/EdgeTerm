import { describe, expect, it } from "vitest";
import { resetSplit, type LayoutNode } from "./layout";

const leaf = (paneId: string): LayoutNode => ({ kind: "leaf", paneId });

const split = (sizes: number[], children: LayoutNode[], direction: "row" | "column" = "row") =>
  ({ kind: "split", direction, sizes, children }) as LayoutNode;

/**
 * Double-click on a boundary: the pair shares its space evenly again, the
 * pair's total is kept, and nothing outside that boundary moves.
 */
describe("resetSplit", () => {
  it("evens the pair at the root and keeps the total", () => {
    const reset = resetSplit(split([0.75, 0.25], [leaf("a"), leaf("b")]), [], 0);
    expect(reset.kind === "split" && reset.sizes).toEqual([0.5, 0.5]);
  });

  it("is a no-op when the pair is already even", () => {
    const node = split([0.5, 0.5], [leaf("a"), leaf("b")]);
    expect(resetSplit(node, [], 0)).toBe(node);
  });

  it("resets the boundary it was given, not its neighbours", () => {
    const root = split([0.6, 0.4], [leaf("a"), leaf("b")]);
    const nested = split([0.8, 0.2], [leaf("c"), leaf("d")], "column");
    const tree = split([0.5, 0.5], [root, nested]);
    const reset = resetSplit(tree, [1], 0);
    const children = reset.kind === "split" ? reset.children : [];
    expect(children[0] === root, "the untouched side keeps its identity").toBe(true);
    expect(children[1].kind === "split" && children[1].sizes).toEqual([0.5, 0.5]);
  });

  it("ignores an index that names no boundary", () => {
    const node = split([0.5, 0.5], [leaf("a"), leaf("b")]);
    expect(resetSplit(node, [], 5)).toBe(node);
  });
});
