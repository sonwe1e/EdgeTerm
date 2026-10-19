import { describe, expect, it } from "vitest";

import INDEX from "../index.html?raw";
import { SEMANTIC_BANDS, SEMANTIC_PALETTES } from "./semanticColors";
import STYLES from "./styles/foundation.styles.css?raw";
import { isLightTheme, THEME_MODES, type ThemeMode } from "./types";

const MODES: readonly ThemeMode[] = THEME_MODES;

/** The value a theme's block gives one custom property. */
function token(mode: ThemeMode, name: string): string {
  const block = STYLES.slice(
    STYLES.indexOf(`:root[data-theme="${mode}"] {`),
  );
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(block.slice(0, block.indexOf("}")));
  if (!found) throw new Error(`${mode} declares no ${name}`);
  return found[1].trim();
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Record<ThemeMode, …> makes the compiler check the palettes a theme is
// looked up in; the stylesheet and the pre-paint script in index.html are
// plain text, and a theme missing from either shows up only at runtime — as
// the dark palette with no warning.
describe("every theme", () => {
  it("has a palette block in the stylesheet", () => {
    for (const mode of MODES) {
      // The dark palette is the :root default the others override.
      if (mode === "dark") continue;
      expect(STYLES, mode).toContain(`:root[data-theme="${mode}"] {`);
    }
  });

  it("declares the color-scheme its canvas needs", () => {
    for (const mode of MODES) {
      if (mode === "dark") continue;
      const block = STYLES.slice(
        STYLES.indexOf(`:root[data-theme="${mode}"] {`),
      );
      const scheme = isLightTheme(mode) ? "light" : "dark";
      expect(block.slice(0, block.indexOf("}")), mode).toContain(
        `color-scheme: ${scheme};`,
      );
    }
  });

  it("is accepted by the first-paint guard in index.html", () => {
    for (const mode of MODES) {
      expect(INDEX, mode).toContain(`"${mode}"`);
    }
  });

  it("colors semantic ranges and bands", () => {
    for (const mode of MODES) {
      expect(SEMANTIC_PALETTES[mode].red, mode).toMatch(/^#[0-9a-f]{6}$/);
      expect(SEMANTIC_BANDS[mode].error, mode).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // The selected row is the one place a theme either carries a choice or loses
  // it: --bg-active sits under the session list, the sender list, the
  // workbench tree, the CodeMirror selection and the expanded status button.
  // The dark half selects with a saturated blue at about 1.48:1 against its
  // panel; the light halves used to use a gray a few per cent away from theirs
  // (1.19:1), which read as a seam. 1.25:1 is the floor below which a
  // selection is decoration rather than a state.
  it("makes the selected row visible against its panel", () => {
    for (const mode of MODES) {
      const block = mode === "dark" ? ":root" : `:root[data-theme="${mode}"]`;
      const selected = mode === "dark" ? "#04395e" : token(mode, "--bg-active");
      const panel = mode === "dark" ? "#181818" : token(mode, "--bg-panel");
      expect(contrast(selected, panel), `${block} --bg-active on --bg-panel`)
        .toBeGreaterThanOrEqual(1.25);
    }
  });
});
