import { describe, expect, it } from "vitest";
import {
  composite,
  contrastRatio,
  directText,
  domPath,
  isLargeText,
  paintedTextColor,
  parseColor,
  relativeLuminance,
  type Rgba,
} from "./uiAudit";

// Pure colour and DOM-path maths: the contrast collector is only as honest as
// these functions, so they are pinned to WCAG's published reference values
// rather than to each other.
const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };

describe("parseColor", () => {
  it("reads every form a computed style or a test can hand it", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0039")).toEqual({ r: 0, g: 0, b: 51, a: 0.6 });
    expect(parseColor("#181818")).toEqual({ r: 24, g: 24, b: 24, a: 1 });
    expect(parseColor("#00000080")).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
    expect(parseColor("rgb(31, 31, 31)")).toEqual({ r: 31, g: 31, b: 31, a: 1 });
    expect(parseColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null for forms it cannot measure instead of guessing", () => {
    expect(parseColor("linear-gradient(#fff, #000)")).toBeNull();
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});

describe("contrast", () => {
  it("matches WCAG's own anchors", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the canonical 4.54:1 boundary case.
    expect(contrastRatio(parseColor("#767676")!, white)).toBeCloseTo(4.54, 2);
    expect(contrastRatio(parseColor("#777777")!, white)).toBeCloseTo(4.48, 2);
  });

  it("is symmetric and uses the same luminance anchor as the spec", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(contrastRatio(white, black), 10);
    expect(relativeLuminance(white)).toBeCloseTo(1, 10);
    expect(relativeLuminance(black)).toBeCloseTo(0, 10);
  });
});

describe("compositing", () => {
  it("puts a translucent ink on the surface it is really painted over", () => {
    const half = parseColor("rgba(0, 0, 0, 0.5)")!;
    expect(paintedTextColor(half, white)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(composite({ r: 0, g: 0, b: 0, a: 0 }, white)).toEqual(white);
    expect(composite({ r: 255, g: 0, b: 0, a: 1 }, white)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 1,
    });
  });
});

describe("isLargeText", () => {
  it("uses the size-or-size-and-weight exemption, not a rounded guess", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.65, 700)).toBe(false);
    expect(isLargeText(18.66, 600)).toBe(false);
  });
});

describe("domPath and directText", () => {
  it("locates an element by its nearest stable classes", () => {
    const outer = document.createElement("div");
    outer.className = "status-bar is-fancy";
    const inner = document.createElement("span");
    inner.className = "status-item";
    outer.append(inner);
    document.body.append(outer);
    expect(domPath(inner)).toBe("div.status-bar > span.status-item");
    outer.remove();
  });

  it("reads only the element's own text, never its children's", () => {
    const parent = document.createElement("div");
    parent.append("plain");
    const child = document.createElement("span");
    child.textContent = "nested";
    parent.append(child);
    expect(directText(parent)).toBe("plain");
    expect(directText(child)).toBe("nested");
    expect(directText(document.createElement("div"))).toBe("");
  });
});
