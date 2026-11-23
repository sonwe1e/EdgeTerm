import { expect, it } from "vitest";

/**
 * The motion contract: every state change (a `transition`) either uses one of
 * the two duration tokens or is instant. Longer motion is a keyframe animation
 * and keeps its own timing — the distinction is the point, so animations are
 * not walked.
 *
 * The check reads the compiled stylesheet the app actually ships, not the
 * source, and reads the shorthand: a duration written as `120ms` expands to a
 * longhand, while one written as `var(--dur-2)` stays an unresolved token, so
 * only the authored text proves which one a rule uses.
 */
interface Measured {
  selector: string;
  value: string;
}

const TOKEN = /var\(--dur-[12]\)/;
const LITERAL = /\b\d+(?:\.\d+)?m?s\b/g;
const INSTANT = /^0m?s$/;

function walk(rules: CSSRuleList, out: Measured[]) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const value = rule.style.getPropertyValue("transition").trim();
      if (value) out.push({ selector: rule.selectorText ?? "", value });
      continue;
    }
    if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules, out);
  }
}

/** Every transition declaration in every stylesheet the document can read. */
const measure = (): Measured[] => {
  const out: Measured[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, out);
    } catch {
      // A sheet the document cannot read is not the app's own CSS.
    }
  }
  return out;
};

/**
 * xterm draws its own scroll fade from its own stylesheet: that is the
 * terminal's contract, not the app's. Everything else is ours.
 */
const offenders = (measured: Measured[]) =>
  measured
    .filter((rule) => !rule.selector.startsWith(".xterm"))
    .filter((rule) => (rule.value.match(LITERAL) ?? []).some((value) => !INSTANT.test(value)))
    .map((rule) => rule.selector + " :: " + rule.value);

it("uses a duration token for every transition", async () => {
  await import("../styles.css");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // A rule with a stray literal must be caught, or an empty result proves
  // nothing but that the walker saw nothing.
  const probe = document.createElement("style");
  probe.textContent = ".motion-probe { transition: color 200ms ease; }";
  document.head.append(probe);
  const withProbe = offenders(measure());
  probe.remove();
  expect(withProbe, "the walker detects a literal duration").toContain(
    ".motion-probe :: color 200ms",
  );

  const measured = measure();
  expect(offenders(measured), "transition durations outside --dur-1/--dur-2").toEqual([]);
  expect(measured.length, "transition declarations inspected").toBeGreaterThan(20);
  expect(
    measured.filter((rule) => TOKEN.test(rule.value)).length,
    "declarations that actually use a token",
  ).toBeGreaterThan(20);
});
