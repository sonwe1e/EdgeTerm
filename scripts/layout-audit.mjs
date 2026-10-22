// Objective layout evidence for the status-bar popover scenes.
//
// A screenshot needs a human eye; these checks do not. One call measures the
// open popover in the page and returns plain numbers for the manifest:
//
//   - viewport margins of the frame, and the body's horizontal overflow;
//   - descendants whose border box crosses the frame's inner edges;
//   - row fit (scroll size vs client size) and row pitch, per row class;
//   - the status bar's triggers: rects, height, vertical centring, overlap,
//     and the bar's own overflow;
//   - a responsive element cluster's visibility and whether its boxes fit the
//     bar that holds them (selectors passed in);
//   - contrast of body copy against its effective background, per class.
//
// The module is deliberately free of repository imports and of the shot
// driver: callers pass selectors and expectations, so a later harness (or a
// layout check for another surface) reuses the same measurements. It reports;
// it does not throw. The caller decides whether a failed assertion warns or
// fails the run.
//
// Boundaries: Chromium's computed style. It proves geometry under this
// fixture's fonts, widths and themes; it cannot prove WebView2, GPU paint or
// another platform's metrics.

/** WCAG is the standard the chrome already follows; keep the numbers named. */
export const LAYOUT_LIMITS = Object.freeze({
  /** The frame must keep at least this much viewport on every side. */
  margin: 8,
  /** One sub-pixel of rounding is not overflow. */
  tolerance: 1,
  /** Status-bar triggers share `--h-control-xs`. */
  triggerHeight: 20,
  /** A trigger's vertical centre may sit this far from the bar's centre. */
  centerTolerance: 2,
  /** WCAG 2.2 AA: body text, and large text (24px, or 18.66px bold). */
  bodyContrast: 4.5,
  largeContrast: 3,
});

const SELECTOR = {
  popover: ".status-popover",
  body: ".status-popover-body",
  bar: ".statusbar",
  triggers: [".resource-monitor", ".forward-center", ".transfer-center"],
};

/**
 * Measure one open popover plus the status bar.
 *
 * @param {import("playwright").Page} page
 * @param {{
 *   scene: string,
 *   rowGroups?: {selector: string, pitch?: number, pitchVar?: string, rowPitch?: boolean, count?: number, fit?: boolean}[],
 *   containers?: string[],
 *   elements?: {visible?: string[], hidden?: string[], fitWithin?: {selector: string, within: string, maxHeight?: number}[]},
 *   contrast?: string[],
 *   limits?: Partial<typeof LAYOUT_LIMITS>,
 * }} options
 */
export async function auditLayout(page, options) {
  const config = {
    scene: options.scene,
    rowGroups: options.rowGroups ?? [],
    containers: options.containers ?? [],
    elements: options.elements ?? null,
    contrast: options.contrast ?? [],
    limits: { ...LAYOUT_LIMITS, ...(options.limits ?? {}) },
    selectors: SELECTOR,
  };
  return page.evaluate(measureLayout, config);
}

/**
 * Runs in the page. Kept as one self-contained function because
 * `page.evaluate` serialises its source: helpers live inside, and only
 * `config` crosses the boundary.
 */
function measureLayout(config) {
  const limits = config.limits;
  const selectors = config.selectors;
  const assertions = [];
  const round = (value) => Math.round(value * 10) / 10;
  const n = (value) => Math.round(value * 100) / 100;

  const push = (id, pass, detail) => {
    assertions.push({ id, pass: Boolean(pass), detail });
  };

  const label = (element) => {
    const tag = element.tagName.toLowerCase();
    const raw = element.getAttribute("class");
    if (!raw) return tag;
    const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag;
  };

  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: n(rect.x), y: n(rect.y),
      width: n(rect.width), height: n(rect.height),
      left: n(rect.left), top: n(rect.top),
      right: n(rect.right), bottom: n(rect.bottom),
    };
  };

  const scrollOf = (element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  });

  // --- colour ---------------------------------------------------------------

  const parseColor = (value) => {
    if (!value || value === "transparent" || value === "none") return null;
    const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
    const srgb = value.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
    const body = rgb ? rgb[1] : srgb ? srgb[1] : null;
    if (!body) return null;
    const parts = body.split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    const scale = srgb ? 255 : 1;
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return {
      r: parts[0] * scale, g: parts[1] * scale, b: parts[2] * scale,
      a: Math.max(0, Math.min(1, alpha)),
    };
  };

  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });

  /** The nearest opaque-ish surface under `element`, composited root first. */
  const effectiveBackground = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const parsed = parseColor(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.a > 0) layers.push(parsed);
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) base = blend(layers[index], base);
    return base;
  };

  const channel = (value) => {
    const part = value / 255;
    return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
  };
  const luminance = ({ r, g, b }) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (foreground, background) => {
    const one = luminance(foreground);
    const two = luminance(background);
    const lighter = Math.max(one, two);
    const darker = Math.min(one, two);
    return (lighter + 0.05) / (darker + 0.05);
  };

  const isLargeText = (fontSize, fontWeight) =>
    fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

  const contrastFor = (element) => {
    const style = getComputedStyle(element);
    const color = parseColor(style.color);
    if (!color) return null;
    const background = effectiveBackground(element);
    const foreground = color.a < 1 ? blend(color, background) : color;
    const fontSize = parseFloat(style.fontSize) || 0;
    const fontWeight = Number(style.fontWeight) || 400;
    const large = isLargeText(fontSize, fontWeight);
    const required = large ? limits.largeContrast : limits.bodyContrast;
    // Compare the exact ratio; round only what the manifest shows, so a
    // reading of 4.46:1 cannot round up into a pass.
    const exact = contrast(foreground, background);
    return {
      ratio: Math.round(exact * 100) / 100,
      passes: exact >= required,
      required,
      large,
      fontSize: round(fontSize),
      fontWeight,
      color: `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`,
      background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
    };
  };

  // --- geometry -------------------------------------------------------------

  const isClippedByAncestor = (element, stopAt) => {
    const rect = element.getBoundingClientRect();
    for (let node = element.parentElement; node && node !== stopAt; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clips = /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`);
      if (!clips) continue;
      const parentBox = node.getBoundingClientRect();
      if (
        rect.left < parentBox.left - limits.tolerance ||
        rect.right > parentBox.right + limits.tolerance ||
        rect.top < parentBox.top - limits.tolerance ||
        rect.bottom > parentBox.bottom + limits.tolerance
      ) {
        return true; // clipped by a deliberate scroll/clip container
      }
    }
    return false;
  };

  const record = {
    scene: config.scene,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    popover: null,
    rows: [],
    containers: [],
    statusbar: null,
    contrast: [],
    assertions,
    failures: [],
  };

  const popover = document.querySelector(selectors.popover);
  const bar = document.querySelector(selectors.bar);

  // --- the frame ------------------------------------------------------------

  if (!popover) {
    record.note = "no .status-popover is open; geometry not measured";
  } else {
    const frame = popover.getBoundingClientRect();
    const style = getComputedStyle(popover);
    const border = {
      top: parseFloat(style.borderTopWidth) || 0,
      right: parseFloat(style.borderRightWidth) || 0,
      bottom: parseFloat(style.borderBottomWidth) || 0,
      left: parseFloat(style.borderLeftWidth) || 0,
    };
    const inner = {
      left: frame.left + border.left,
      top: frame.top + border.top,
      right: frame.right - border.right,
      bottom: frame.bottom - border.bottom,
    };
    const margins = {
      left: round(frame.left),
      top: round(frame.top),
      right: round(window.innerWidth - frame.right),
      bottom: round(window.innerHeight - frame.bottom),
    };
    const rawMargins = {
      left: frame.left,
      top: frame.top,
      right: window.innerWidth - frame.right,
      bottom: window.innerHeight - frame.bottom,
    };
    const body = popover.querySelector(selectors.body);
    const bodyScroll = body ? scrollOf(body) : null;
    const scrollsVertically = Boolean(bodyScroll && bodyScroll.scrollHeight > bodyScroll.clientHeight + 1);

    push(
      "popover.margin",
      Object.values(rawMargins).every((value) => value >= limits.margin),
      `margins l=${margins.left} t=${margins.top} r=${margins.right} b=${margins.bottom}`,
    );

    if (bodyScroll) {
      push(
        "popover.body.horizontalOverflow",
        bodyScroll.scrollWidth <= bodyScroll.clientWidth + limits.tolerance,
        `body scrollWidth=${bodyScroll.scrollWidth} clientWidth=${bodyScroll.clientWidth}`,
      );
    }

    const crossings = [];
    for (const element of popover.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (isClippedByAncestor(element, popover)) continue;
      const sides = [];
      if (rect.left < inner.left - limits.tolerance) sides.push("left");
      if (rect.right > inner.right + limits.tolerance) sides.push("right");
      if (rect.top < inner.top - limits.tolerance && !(bodyScroll && bodyScroll.scrollTop > limits.tolerance)) {
        sides.push("top");
      }
      if (rect.bottom > inner.bottom + limits.tolerance && !scrollsVertically) sides.push("bottom");
      if (sides.length > 0) {
        if (crossings.length < 20) {
          crossings.push({
            element: label(element),
            sides,
            rect: box(element),
            overflow: {
              left: round(Math.max(0, inner.left - rect.left)),
              right: round(Math.max(0, rect.right - inner.right)),
              top: round(Math.max(0, inner.top - rect.top)),
              bottom: round(Math.max(0, rect.bottom - inner.bottom)),
            },
          });
        }
      }
    }
    push(
      "popover.crossings",
      crossings.length === 0,
      crossings.length === 0
        ? "no descendant crosses the frame's inner edges"
        : `${crossings.length} crossing(s): ${crossings.slice(0, 4).map((item) => `${item.element}(${item.sides.join("+")})`).join(", ")}`,
    );

    record.popover = {
      rect: box(popover),
      margins,
      inner: {
        left: n(inner.left), top: n(inner.top),
        right: n(inner.right), bottom: n(inner.bottom),
      },
      body: bodyScroll ? { ...bodyScroll, scrollsVertically } : null,
      crossings,
    };
  }

  // --- scroll containers ----------------------------------------------------

  for (const selector of config.containers) {
    const element = document.querySelector(selector);
    if (!element) {
      record.containers.push({ selector, present: false, fit: false });
      push(`container.${selector}.fit`, false, `${selector} is not on screen`);
      continue;
    }
    const scroll = scrollOf(element);
    const fit = scroll.scrollWidth <= scroll.clientWidth + limits.tolerance;
    record.containers.push({ selector, present: true, scroll, fit });
    push(`container.${selector}.fit`, fit, `${selector} scrollWidth=${scroll.scrollWidth} clientWidth=${scroll.clientWidth}`);
  }

  // --- row fit and rhythm ---------------------------------------------------

  for (const group of config.rowGroups) {
    const elements = Array.from(document.querySelectorAll(group.selector));
    if (elements.length === 0) {
      record.rows.push({ selector: group.selector, present: false });
      continue;
    }
    const heights = elements.map((element) => n(element.getBoundingClientRect().height));
    const boxes = elements.map((element) => box(element));
    const pitches = [];
    for (let index = 1; index < boxes.length; index += 1) {
      pitches.push(n(boxes[index].top - boxes[index - 1].top));
    }
    const gaps = pitches.map((pitch, index) => n(pitch - heights[index]));

    let expected = null;
    if (typeof group.pitch === "number") expected = group.pitch;
    if (typeof group.pitchVar === "string") {
      const value = parseFloat(getComputedStyle(elements[0]).getPropertyValue(group.pitchVar));
      if (Number.isFinite(value)) expected = value;
      else {
        push(
          `rows.${group.selector}.pitchVar`,
          false,
          `${group.selector} declares no ${group.pitchVar}, so its pitch cannot be asserted`,
        );
      }
    }

    const row = { selector: group.selector, present: true, heights, pitches, gaps, expected };
    if (group.fit !== false) {
      const fit = elements.map((element, index) => {
        const scroll = scrollOf(element);
        return {
          index,
          height: heights[index],
          clientWidth: scroll.clientWidth,
          scrollWidth: scroll.scrollWidth,
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          pass:
            scroll.scrollWidth <= scroll.clientWidth + limits.tolerance &&
            scroll.scrollHeight <= scroll.clientHeight + limits.tolerance,
        };
      });
      const failing = fit.filter((entry) => !entry.pass);
      push(
        `rows.${group.selector}.fit`,
        failing.length === 0,
        failing.length === 0
          ? `${elements.length} row(s) fit`
          : `${failing.length}/${elements.length} overflow: ${failing.slice(0, 3).map((entry) => `#${entry.index} ${entry.scrollWidth}x${entry.scrollHeight} in ${entry.clientWidth}x${entry.clientHeight}`).join(", ")}`,
      );
      row.fit = fit;
    }

    if (typeof group.count === "number") {
      push(
        `rows.${group.selector}.count`,
        elements.length === group.count,
        `${group.selector} expected ${group.count} row(s), found ${elements.length}`,
      );
      row.count = elements.length;
    }

    if (group.rowPitch) {
      // Grid rows: DOM-ordered tiles share a row top, so the rhythm is the
      // distance between distinct row tops, not between consecutive boxes.
      const tops = [...new Set(boxes.map((item) => n(item.top)))].sort((one, two) => one - two);
      const rowPitches = [];
      for (let index = 1; index < tops.length; index += 1) {
        rowPitches.push(n(tops[index] - tops[index - 1]));
      }
      row.rowPitches = rowPitches;
      if (expected !== null) {
        const off = rowPitches.filter((pitch) => Math.abs(pitch - expected) > limits.tolerance);
        push(
          `rows.${group.selector}.rowPitch`,
          rowPitches.length > 0 && off.length === 0,
          `${group.selector} row pitch expected ${round(expected)}px, measured [${rowPitches.join(", ")}]`,
        );
      }
    } else if (expected !== null) {
      const offPitch = pitches.filter((pitch) => Math.abs(pitch - expected) > limits.tolerance);
      push(
        `rows.${group.selector}.pitch`,
        pitches.length === 0 || offPitch.length === 0,
        `${group.selector} expected ${round(expected)}px, measured [${pitches.join(", ")}]`,
      );
    }

    record.rows.push(row);
  }

  // --- status bar -----------------------------------------------------------

  if (!bar) {
    record.note = record.note ?? "no .statusbar on screen";
  } else {
    const barBox = box(bar);
    const barScroll = scrollOf(bar);
    const triggers = [];
    for (const wrapperSelector of selectors.triggers) {
      const wrapper = bar.querySelector(wrapperSelector);
      if (!wrapper) continue;
      const button = wrapper.matches("button")
        ? wrapper
        : wrapper.querySelector("button[aria-expanded]") ?? wrapper.querySelector("button");
      if (!button) continue;
      const trigger = box(button);
      triggers.push({
        wrapper: wrapperSelector,
        trigger: label(button),
        rect: trigger,
        height: n(trigger.height),
        center: n(trigger.top + trigger.height / 2),
        centerDelta: n(trigger.top + trigger.height / 2 - (barBox.top + barBox.height / 2)),
      });
    }
    triggers.sort((one, two) => one.rect.left - two.rect.left);
    const overlaps = [];
    for (let index = 1; index < triggers.length; index += 1) {
      const previous = triggers[index - 1].rect;
      const current = triggers[index].rect;
      if (current.left < previous.right - limits.tolerance) {
        overlaps.push([triggers[index - 1].trigger, triggers[index].trigger]);
      }
    }
    const heightsOk = triggers.every((item) => Math.abs(item.height - limits.triggerHeight) <= 0.5);
    const centersOk = triggers.every((item) => Math.abs(item.centerDelta) <= limits.centerTolerance);
    const barFits = barScroll.scrollWidth <= barScroll.clientWidth + limits.tolerance;

    push("statusbar.height", heightsOk, triggers.map((item) => `${item.trigger} ${item.height}px`).join(", "));
    push("statusbar.overlap", overlaps.length === 0, overlaps.length === 0 ? "no trigger overlap" : overlaps.map((pair) => pair.join("/")).join(", "));
    push("statusbar.horizontalOverflow", barFits, `bar scrollWidth=${barScroll.scrollWidth} clientWidth=${barScroll.clientWidth}`);
    push("statusbar.verticalCenter", centersOk, triggers.map((item) => `${item.trigger} ${item.centerDelta}px`).join(", "));

    record.statusbar = {
      rect: barBox,
      scroll: barScroll,
      triggers,
      limits: { height: limits.triggerHeight, centerTolerance: limits.centerTolerance },
    };
  }

  // --- element clusters inside the bar --------------------------------------
  // Responsive chrome switches by `display`, so visibility is asserted rather
  // than inferred from a screenshot, and a cluster's own boxes are checked
  // against the bar that holds them. Selectors are passed in; nothing here
  // knows about the monitor, so the same check fits another cluster.
  if (config.elements) {
    const measured = { visible: [], hidden: [], fitWithin: [] };
    const displayOf = (element) => getComputedStyle(element).display;

    for (const selector of config.elements.visible ?? []) {
      const elements = Array.from(document.querySelectorAll(selector));
      const visible = elements.length > 0 && elements.every((element) => {
        const rect = element.getBoundingClientRect();
        return displayOf(element) !== "none" && rect.width > 0 && rect.height > 0;
      });
      measured.visible.push({ selector, count: elements.length, visible });
      push(`elements.${selector}.visible`, visible, `${selector} present=${elements.length} visible=${visible}`);
    }

    for (const selector of config.elements.hidden ?? []) {
      const elements = Array.from(document.querySelectorAll(selector));
      const hidden = elements.length > 0 && elements.every((element) => {
        const rect = element.getBoundingClientRect();
        return displayOf(element) === "none" || rect.width === 0 || rect.height === 0;
      });
      measured.hidden.push({ selector, count: elements.length, hidden });
      push(`elements.${selector}.hidden`, hidden, `${selector} present=${elements.length} hidden=${hidden}`);
    }

    for (const spec of config.elements.fitWithin ?? []) {
      const elements = Array.from(document.querySelectorAll(spec.selector));
      const container = document.querySelector(spec.within);
      if (!container || elements.length === 0) {
        measured.fitWithin.push({ selector: spec.selector, within: spec.within, present: false, fit: false });
        push(
          `elements.${spec.selector}.fitWithin`,
          false,
          `${spec.selector} present=${elements.length} within=${Boolean(container)}`,
        );
        continue;
      }
      const outer = container.getBoundingClientRect();
      const boxesOf = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const scroll = scrollOf(element);
        const contentFits =
          scroll.scrollWidth <= scroll.clientWidth + limits.tolerance &&
          scroll.scrollHeight <= scroll.clientHeight + limits.tolerance;
        const inside =
          rect.left >= outer.left - limits.tolerance &&
          rect.right <= outer.right + limits.tolerance &&
          rect.top >= outer.top - limits.tolerance &&
          rect.bottom <= outer.bottom + limits.tolerance;
        const heightOk = typeof spec.maxHeight === "number"
          ? rect.height <= spec.maxHeight + limits.tolerance
          : true;
        return {
          width: n(rect.width),
          height: n(rect.height),
          contentFits,
          inside,
          heightOk,
          pass: contentFits && inside && heightOk,
        };
      });
      const fit = boxesOf.every((entry) => entry.pass);
      measured.fitWithin.push({ selector: spec.selector, within: spec.within, count: elements.length, boxes: boxesOf, fit });
      push(
        `elements.${spec.selector}.fitWithin`,
        fit,
        `${spec.selector} in ${spec.within}: widths [${boxesOf.map((entry) => entry.width).join(", ")}], heights [${boxesOf.map((entry) => entry.height).join(", ")}], fit=${fit}`,
      );
    }

    record.elements = measured;
  }

  // --- contrast -------------------------------------------------------------

  if (popover) {
    for (const selector of config.contrast) {
      const elements = Array.from(popover.querySelectorAll(selector))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (element.textContent ?? "").trim().length > 0;
        });
      if (elements.length === 0) {
        record.contrast.push({ selector, present: false });
        continue;
      }
      const samples = [];
      for (const element of elements.slice(0, 4)) {
        const measured = contrastFor(element);
        if (!measured) continue;
        samples.push({
          text: (element.textContent ?? "").trim().slice(0, 40),
          ...measured,
        });
      }
      if (samples.length === 0) {
        record.contrast.push({ selector, present: true, measured: false });
        continue;
      }
      const minRatio = Math.min(...samples.map((sample) => sample.ratio));
      const required = Math.max(...samples.map((sample) => sample.required));
      const pass = samples.every((sample) => sample.passes);
      record.contrast.push({
        selector,
        present: true,
        count: elements.length,
        minRatio,
        required,
        pass,
        samples,
      });
      push(`contrast.${selector}`, pass, `${selector} min=${minRatio.toFixed(2)}:1, needs ${required}:1 (${samples.length} sample(s))`);
    }
  }

  record.failures = assertions.filter((assertion) => !assertion.pass).map((assertion) => `${assertion.id}: ${assertion.detail}`);
  return record;
}
