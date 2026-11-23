import { describe, expect, it } from "vitest";

/**
 * Four themes share one token set, so a colour written into a component
 * stylesheet paints the same value in all of them. The literals belong to
 * `foundation.styles.css`, which defines the tokens each theme overrides;
 * everything else names a token. Comments are stripped first, because a note
 * like "upstream issue #108" is not a colour.
 */
const sheets = import.meta.glob("./styles/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FOUNDATION = "./styles/foundation.styles.css";

/** Colour literals in one stylesheet, ignoring comments. */
function literals(css: string): string[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
}

describe("colour literals", () => {
  it("live in the foundation layer, so every theme can override them", () => {
    const offenders: string[] = [];
    for (const [path, css] of Object.entries(sheets)) {
      if (path === FOUNDATION) continue;
      for (const literal of literals(css)) offenders.push(`${path}: ${literal}`);
    }
    expect(offenders).toEqual([]);
  });

  it("are actually defined by the foundation layer, not nowhere", () => {
    const foundation = sheets[FOUNDATION];
    expect(foundation, "foundation.styles.css is part of the scan").toBeTruthy();
    expect(literals(foundation ?? "").length).toBeGreaterThan(100);
  });
});
