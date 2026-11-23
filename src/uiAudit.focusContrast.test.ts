import { describe, expect, it } from "vitest";
import { focusRingContrastIssues } from "./uiAudit";

const box = (element: HTMLElement, width = 48, height = 24): void => {
  element.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
};

/** A focusable button on a wrapper whose surface is known. */
const stage = (ring: string | null, surface = "rgb(255, 255, 255)") => {
  document.body.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.style.backgroundColor = surface;
  const button = document.createElement("button");
  button.textContent = "Run";
  // jsdom expands the shorthand poorly; the collector reads longhands.
  if (ring) {
    button.style.outlineWidth = "2px";
    button.style.outlineStyle = "solid";
    button.style.outlineColor = ring;
  }
  button.style.outlineOffset = "2px";
  wrapper.append(button);
  document.body.append(wrapper);
  box(wrapper);
  box(button);
  return { wrapper, button };
};

describe("focusRingContrastIssues", () => {
  it("accepts a ring that clears 3:1 against its surface", () => {
    stage("rgb(0, 0, 0)");
    const report = focusRingContrastIssues(document.body);
    expect(report.inspected).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("reports a ring drawn in its surface colour", () => {
    stage("rgb(255, 255, 255)");
    const report = focusRingContrastIssues(document.body);
    expect(report.inspected).toBe(1);
    expect(report.issues.map((issue) => issue.detail)).toEqual([
      "focus ring rgb(255, 255, 255) is 1.00:1 against its surface (needs 3:1)",
    ]);
  });

  it("counts an indicator that is not an outline instead of guessing", () => {
    const { button } = stage(null);
    button.style.boxShadow = "0 0 0 2px rgb(0, 120, 212)";
    const report = focusRingContrastIssues(document.body);
    expect(report.inspected).toBe(0);
    expect(report.indeterminate).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("skips controls that never take focus", () => {
    const { button } = stage("rgb(0, 0, 0)");
    button.tabIndex = -1;
    const report = focusRingContrastIssues(document.body);
    expect(report.inspected).toBe(0);
  });
});
