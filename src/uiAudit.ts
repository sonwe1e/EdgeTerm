// Objective visual-quality measurement for the real rendered chrome. The
// repository is reviewed without a human eye on a screenshot, so "the
// interface looks right" has to be stated as numbers a browser can produce:
// the contrast a text run actually has against the surface it is painted on,
// whether a control's hit area is big enough for a pointer, and whether a
// label is cut off by a box that will never show a tooltip. These are the
// properties the interface's own rules (and WCAG) talk about, so a report
// here is a defect list, not an aesthetic score.
//
// Everything in this module is pure DOM reading: no React, no store, no IPC.
// The collectors work on any subtree, which is what lets a browser test point
// them at the whole app, at one dialog, or at a panel.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
};

/**
 * Parses the colour forms computed styles produce ("rgb()/rgba()") plus the
 * authored forms tests use (hex in three, four, six and eight digits,
 * "transparent", black and white). Anything else (a gradient, a named colour
 * outside the map) returns null: the caller must treat that as "cannot be
 * measured", never as a pass.
 */
export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const named = NAMED[text];
  if (named !== undefined) return parseColor(named);
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const expand = (part: string): number =>
      Number.parseInt(part.length === 1 ? part + part : part, 16);
    if (hex.length === 3 || hex.length === 4) {
      const alpha = hex.length === 4 ? expand(hex.slice(3, 4)) / 255 : 1;
      return {
        r: expand(hex.slice(0, 1)),
        g: expand(hex.slice(1, 2)),
        b: expand(hex.slice(2, 3)),
        a: alpha,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a,
      };
    }
    return null;
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (part: string): number => {
    const percent = part.endsWith("%");
    const number = Number.parseFloat(part);
    return percent ? (number / 100) * 255 : number;
  };
  const alpha = parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
  return {
    r: clamp(channel(parts[0]), 0, 255),
    g: clamp(channel(parts[1]), 0, 255),
    b: clamp(channel(parts[2]), 0, 255),
    a: clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1),
  };
}

/** Source-over compositing of `top` on an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: a + bottom.a * (1 - a),
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x contrast ratio, 1-21. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const one = relativeLuminance(foreground);
  const two = relativeLuminance(background);
  const light = Math.max(one, two);
  const dark = Math.min(one, two);
  return (light + 0.05) / (dark + 0.05);
}

/** The glyph colour a text run is actually painted in, composited on its surface. */
export function paintedTextColor(foreground: Rgba, background: Rgba): Rgba {
  return foreground.a >= 1 ? foreground : composite(foreground, background);
}

/** A short, stable locator for a report entry: tag, first class, and the path up. */
export function domPath(element: Element, maxAncestors = 4): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && parts.length < maxAncestors) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const firstClass =
      typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
    parts.unshift(firstClass ? tag + "." + firstClass : tag);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** True when the element's own box is rendered at all. */
function isRendered(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse"
  ) {
    return false;
  }
  if (Number.parseFloat(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

interface Surface {
  color: Rgba;
  /** True when a gradient, image or filter makes the backdrop unknown. */
  indeterminate: boolean;
}

/**
 * The opaque colour behind `element`: walk the ancestor chain root-first and
 * composite every background in turn, which is what the browser paints. The
 * element's own background counts too, because a row that paints its own
 * surface draws its text on that.
 */
export function surfaceBehind(element: Element): Surface {
  const chain: HTMLElement[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement) chain.push(node);
  }
  chain.reverse();
  let color: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  let indeterminate = false;
  for (const node of chain) {
    const style = getComputedStyle(node);
    if (style.backgroundImage && style.backgroundImage !== "none") indeterminate = true;
    // A filter on the element itself also recolours its text, so the measured
    // pair is no longer the pair the reader sees. A backdrop filter is
    // different: it only blurs what lies behind the element, and the element's
    // own background (composited below) still paints under its text.
    if (style.filter && style.filter !== "none") indeterminate = true;
    const painted = parseColor(style.backgroundColor);
    if (painted && painted.a > 0) color = composite(painted, color);
  }
  return { color, indeterminate };
}

/** Direct non-empty text runs of an element. */
export function directText(element: Element): string {
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  }
  return text.trim();
}

const isAriaHidden = (element: Element): boolean =>
  element.closest('[aria-hidden="true"]') !== null;

export interface AuditIssue {
  kind: "contrast" | "target" | "clip" | "focus";
  path: string;
  detail: string;
  /** What a reader would see; kept short for reports. */
  text: string;
  values: Record<string, number | string>;
}

/** The large-text threshold WCAG exempts at 3:1. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

export interface ContrastOptions {
  /** Ratio a normal text run must reach. Defaults to the WCAG AA 4.5:1. */
  normal?: number;
  /** Ratio large text must reach. Defaults to 3:1. */
  large?: number;
  /** Elements matched by this selector are skipped (known decorative runs). */
  ignore?: string;
}

/**
 * Every rendered text run whose painted contrast misses the AA threshold.
 * Gradients and filters make the backdrop unknowable, so those are counted
 * separately instead of being reported as passes or failures.
 */
export function textContrastIssues(
  root: ParentNode,
  options: ContrastOptions = {},
): { issues: AuditIssue[]; indeterminate: number; inspected: number } {
  const normal = options.normal ?? 4.5;
  const large = options.large ?? 3;
  const issues: AuditIssue[] = [];
  let indeterminate = 0;
  let inspected = 0;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const text = directText(element);
    if (!text) continue;
    if (options.ignore && element.matches(options.ignore)) continue;
    if (isAriaHidden(element) || !isRendered(element)) continue;
    const style = getComputedStyle(element);
    const foreground = parseColor(style.color);
    if (!foreground || foreground.a === 0) continue;
    const surface = surfaceBehind(element);
    if (surface.indeterminate) {
      indeterminate++;
      continue;
    }
    inspected++;
    const painted = paintedTextColor(foreground, surface.color);
    const ratio = contrastRatio(painted, surface.color);
    const fontSize = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    const required = isLargeText(fontSize, weight) ? large : normal;
    if (ratio + 1e-6 < required) {
      issues.push({
        kind: "contrast",
        path: domPath(element),
        detail: ratio.toFixed(2) + ":1 < " + required + ":1 at " + fontSize + "px/" + weight,
        text: text.slice(0, 60),
        values: { ratio: Number(ratio.toFixed(2)), required, fontSize, weight },
      });
    }
  }
  return { issues, indeterminate, inspected };
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="separator"]',
  '[role="slider"]',
].join(",");

export interface TargetOptions {
  /** The WCAG 2.2 AA target size. Defaults to its 24 CSS pixels. */
  min?: number;
  /**
   * The edge below which a control is reported even when its spacing is
   * clean. WCAG allows an undersized target that has room around it; a 5px
   * breadcrumb still misses the point of a click target, so the report keeps
   * a usability floor of its own.
   */
  floor?: number;
  ignore?: string;
}

interface Candidate {
  element: HTMLElement;
  rect: DOMRect;
}

/** Centre of a box, the anchor WCAG's spacing exception measures from. */
const centre = (rect: DOMRect): { x: number; y: number } => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/**
 * An input wrapped in its own label is pointed at through the label: the
 * label is the target the reader hits, and it is usually far larger than the
 * box. Counting the bare box would report every checkbox in the app.
 */
const labelledControl = (element: HTMLElement): boolean => element.closest("label") !== null;

/**
 * Pointer targets that miss WCAG 2.2 AA's 24x24 minimum. The spacing
 * exception is applied rather than a blanket size rule: an undersized
 * control whose 24px circle is clear of every other target passes the
 * standard, which is why a compact professional toolbar can be compliant.
 * Targets below the usability floor are reported regardless - a 5px
 * breadcrumb is not made usable by empty space around it.
 */
export function targetSizeIssues(
  root: ParentNode,
  options: TargetOptions = {},
): { issues: AuditIssue[]; inspected: number } {
  const min = options.min ?? 24;
  const floor = options.floor ?? 16;
  const candidates: Candidate[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR))) {
    if (options.ignore && element.matches(options.ignore)) continue;
    if (element.getAttribute("tabindex") === "-1" && !element.matches("button,a[href]")) continue;
    if (isAriaHidden(element)) continue;
    if ((element as HTMLButtonElement).disabled) continue;
    if (labelledControl(element)) continue;
    if (!isRendered(element)) continue;
    const style = getComputedStyle(element);
    if (style.display === "inline" && element.tagName === "A") continue;
    candidates.push({ element, rect: element.getBoundingClientRect() });
  }
  const issues: AuditIssue[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const { rect } = candidate;
    if (rect.width + 0.5 >= min && rect.height + 0.5 >= min) continue;
    const here = centre(rect);
    const crowded = candidates.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (candidate.element.contains(other.element) || other.element.contains(candidate.element)) {
        return false;
      }
      const there = centre(other.rect);
      return Math.hypot(here.x - there.x, here.y - there.y) < min - 0.5;
    });
    const edge = Math.min(rect.width, rect.height);
    if (!crowded && edge + 0.5 >= floor) continue;
    const size = Math.round(rect.width) + "x" + Math.round(rect.height);
    issues.push({
      kind: "target",
      path: domPath(candidate.element),
      detail: crowded
        ? size +
          " < " +
          min +
          "x" +
          min +
          ", and a neighbouring target sits inside its " +
          min +
          "px circle"
        : size + " < " + floor + "px floor with clear spacing",
      text:
        (candidate.element.getAttribute("aria-label") || candidate.element.textContent || "")
          .trim()
          .slice(0, 60) || candidate.element.tagName.toLowerCase(),
      values: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        min,
        crowded: crowded ? 1 : 0,
      },
    });
  }
  return { issues, inspected: candidates.length };
}

/**
 * Labels the layout cuts off. A deliberate ellipsis is not a defect - the
 * overflow tooltip exists for exactly that case - but hidden overflow with
 * neither an ellipsis nor a tooltip is text the reader can never get back.
 */
export function clippedTextIssues(root: ParentNode): { issues: AuditIssue[]; inspected: number } {
  const issues: AuditIssue[] = [];
  let inspected = 0;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const text = directText(element);
    if (!text || isAriaHidden(element) || !isRendered(element)) continue;
    // Visually-hidden text (the sr-only pattern) is clipped on purpose and is
    // read by assistive technology in full; it is not layout damage.
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const style = getComputedStyle(element);
    inspected++;
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
    const ellipsis = style.textOverflow === "ellipsis";
    const ownTooltip =
      element.closest("[data-own-tooltip]") !== null || element.hasAttribute("title");
    if (clipsX && !ellipsis && !ownTooltip) {
      const over = element.scrollWidth - element.clientWidth;
      if (over > 1) {
        issues.push({
          kind: "clip",
          path: domPath(element),
          detail: over + "px of text beyond the box, no ellipsis or tooltip",
          text: text.slice(0, 60),
          values: { overflowPx: over },
        });
        continue;
      }
    }
    if (clipsY && !ellipsis) {
      const over = element.scrollHeight - element.clientHeight;
      if (over > 1 && style.whiteSpace !== "normal") {
        issues.push({
          kind: "clip",
          path: domPath(element),
          detail: over + "px of text below the box",
          text: text.slice(0, 60),
          values: { overflowPx: over },
        });
      }
    }
  }
  return { issues, inspected };
}

export interface StyleCensus {
  fontSize: Record<string, number>;
  lineHeight: Record<string, number>;
  radius: Record<string, number>;
  color: Record<string, number>;
  background: Record<string, number>;
  elements: number;
}

const bump = (bucket: Record<string, number>, key: string): void => {
  bucket[key] = (bucket[key] ?? 0) + 1;
};

/** A frequency table of the typographic and shape values actually painted. */
export function styleCensus(root: ParentNode): StyleCensus {
  const census: StyleCensus = {
    fontSize: {},
    lineHeight: {},
    radius: {},
    color: {},
    background: {},
    elements: 0,
  };
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (!isRendered(element)) continue;
    census.elements++;
    const style = getComputedStyle(element);
    const hasText = directText(element) !== "";
    if (hasText) {
      bump(census.fontSize, style.fontSize);
      bump(census.lineHeight, style.lineHeight);
      bump(census.color, style.color);
    }
    if (style.borderTopLeftRadius !== "0px") bump(census.radius, style.borderTopLeftRadius);
    if (style.backgroundColor !== "rgba(0, 0, 0, 0)")
      bump(census.background, style.backgroundColor);
  }
  return census;
}
/**
 * The computed properties that can make focus visible. A control that changes
 * none of them when focused is invisible to a keyboard user even if the
 * stylesheet "has a :focus-visible rule" for some other selector.
 */
const FOCUS_PROPS = [
  "outline",
  "outlineColor",
  "outlineStyle",
  "outlineWidth",
  "boxShadow",
  "backgroundColor",
  "borderColor",
  "color",
  "textDecorationLine",
  "filter",
] as const;

const focusSnapshot = (element: Element): string => {
  const style = getComputedStyle(element);
  return FOCUS_PROPS.map((name) => style[name as keyof CSSStyleDeclaration]).join("|");
};

export interface FocusOptions {
  /** How many focusable controls to inspect; the whole shell is ~120. */
  limit?: number;
  ignore?: string;
}

/**
 * Controls that look identical before and after keyboard focus, including
 * their two nearest ancestors (a row may own the ring, and that is fine).
 * Programmatic focus is only honest after keyboard modality exists, so the
 * caller must send one real Tab first: Chromium then lets the scripted focus
 * inherit :focus-visible from the element the Tab landed on.
 */
export function focusRingIssues(
  root: ParentNode,
  options: FocusOptions = {},
): { issues: AuditIssue[]; inspected: number } {
  const limit = options.limit ?? 200;
  const issues: AuditIssue[] = [];
  let inspected = 0;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  for (const element of candidates) {
    if (inspected >= limit) break;
    if (options.ignore && element.matches(options.ignore)) continue;
    if (isAriaHidden(element) || !isRendered(element)) continue;
    if ((element as HTMLButtonElement).disabled) continue;
    // A negative tabIndex is not a Tab stop. Rows inside an
    // aria-activedescendant list are reached through their container, which is
    // the real focus stop; focusing every row would invent defects.
    if (element.tabIndex < 0) continue;
    const chain = [element, element.parentElement, element.parentElement?.parentElement].filter(
      (node): node is HTMLElement => node !== null,
    );
    // An element the Tab that established keyboard modality landed on is
    // already focused: snapshotting it first would compare focus with itself.
    if (document.activeElement === element) element.blur();
    const before = chain.map(focusSnapshot);
    element.focus({ preventScroll: true });
    if (document.activeElement !== element) {
      // Not focusable for a platform reason (a closed details, a hidden input):
      // there is no focus state to grade.
      element.blur();
      continue;
    }
    inspected++;
    const after = chain.map(focusSnapshot);
    const changed = before.some((snapshot, index) => snapshot !== after[index]);
    if (!changed) {
      issues.push({
        kind: "focus",
        path: domPath(element),
        detail: "no visible change on keyboard focus",
        text:
          (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 60) ||
          element.tagName.toLowerCase(),
        values: { ancestors: chain.length - 1 },
      });
    }
    element.blur();
  }
  return { issues, inspected };
}
export interface FocusContrastReport {
  issues: AuditIssue[];
  /** Rings whose colour could be read and compared. */
  inspected: number;
  /**
   * Focus stops whose indicator is not an outline (a soft box-shadow, a
   * native platform ring, an ancestor's decoration) or whose backdrop is a
   * gradient. They are counted, not guessed at: WCAG 1.4.11 is about the
   * colour pair the reader sees, and neither side is known here.
   */
  indeterminate: number;
}

/**
 * WCAG 1.4.11 non-text contrast, applied to the focus indicator itself. The
 * change-based sweep proves a ring exists; this proves a keyboard user can
 * see it. A ring drawn in a colour that matches its surface is invisible even
 * though every computed property changed, which is exactly the defect a
 * "does :focus-visible exist" check cannot find.
 *
 * Only outlines are graded, because an outline has one colour and one side of
 * the border box the colour is measured against. A box-shadow ring is counted
 * as indeterminate: a shadow may be inset, spread, layered or a soft glow,
 * and reconstructing the painted colour would replace a real measurement with
 * an estimate.
 */
export function focusRingContrastIssues(
  root: ParentNode,
  options: FocusOptions = {},
): FocusContrastReport {
  const limit = options.limit ?? 200;
  const issues: AuditIssue[] = [];
  let inspected = 0;
  let indeterminate = 0;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  for (const element of candidates) {
    if (inspected + indeterminate >= limit) break;
    if (options.ignore && element.matches(options.ignore)) continue;
    if (isAriaHidden(element) || !isRendered(element)) continue;
    if ((element as HTMLButtonElement).disabled) continue;
    if (element.tabIndex < 0) continue;
    if (document.activeElement === element) element.blur();
    element.focus({ preventScroll: true });
    if (document.activeElement !== element) continue;
    const style = getComputedStyle(element);
    const width = Number.parseFloat(style.outlineWidth) || 0;
    const ring = style.outlineStyle === "none" ? null : parseColor(style.outlineColor);
    element.blur();
    if (!ring || width <= 0) {
      indeterminate++;
      continue;
    }
    // An inset ring (negative offset) is drawn on the element's own surface;
    // a positive-offset ring sits on whatever is behind the element.
    const inset = (Number.parseFloat(style.outlineOffset) || 0) < 0;
    const behind = surfaceBehind(inset ? element : (element.parentElement ?? element));
    if (behind.indeterminate) {
      indeterminate++;
      continue;
    }
    inspected++;
    const ratio = contrastRatio(ring, behind.color);
    if (ratio < 3) {
      issues.push({
        kind: "focus",
        path: domPath(element),
        detail:
          "focus ring " +
          style.outlineColor +
          " is " +
          ratio.toFixed(2) +
          ":1 against its surface (needs 3:1)",
        text:
          (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 60) ||
          element.tagName.toLowerCase(),
        values: { ratio: Math.round(ratio * 100) / 100 },
      });
    }
  }
  return { issues, inspected, indeterminate };
}
