import { describe, expect, it } from "vitest";

import INDEX from "../index.html?raw";
import { SEMANTIC_BANDS, SEMANTIC_PALETTES } from "./semanticColors";
import STYLES from "./styles/foundation.styles.css?raw";
import { isLightTheme, THEME_MODES, type ThemeMode } from "./types";

const MODES: readonly ThemeMode[] = THEME_MODES;

/** The value a theme's block gives one custom property. The dark palette is
    the :root default the other three override, and a value may be a var()
    reference to another property of the same palette, which is followed. */
function token(mode: ThemeMode, name: string): string {
  const selector = mode === "dark" ? ":root {" : `:root[data-theme="${mode}"] {`;
  const start = STYLES.indexOf(selector);
  const block = STYLES.slice(start, STYLES.indexOf("}", start));
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!found) throw new Error(`${mode} declares no ${name}`);
  const value = found[1].trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference ? token(mode, reference[1]) : value;
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

/** A colour mixed into a surface at a percentage, the way the pill rules
    composite it with color-mix(in srgb, … n%, transparent): the tint lands on
    top of whatever the rule sits on, so the pair to measure is ink against
    the composited surface, not against the bare panel. */
function tint(color: string, percent: number, surface: string): string {
  const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const ink = channels(color);
  const base = channels(surface);
  const mixed = ink.map((value, at) => Math.round(value * percent + base[at] * (1 - percent)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
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

  // The accent ink has to flip with the palette, the way --danger-contrast and
  // --warn-contrast already do. serialx-dark's lavender is the lightest accent
  // of the four: white on it measured 3.00:1, on every primary button and every
  // menu hover row, so it takes the near-black ink (5.50:1). dark's white on
  // #0078d4 is the tight one at 4.53:1 — it clears the floor by 0.03 and is
  // asserted here rather than deepened, which would move the whole palette.
  it("keeps the accent ink readable on the accent", () => {
    for (const mode of MODES) {
      expect(
        contrast(token(mode, "--accent-contrast"), token(mode, "--accent")),
        `${mode} --accent-contrast on --accent`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// A pill writes an ink on a tint of its own colour. The tint lifts the light
// canvases toward the middle of the ramp, and there the mid-tone greens, blues
// and teals fell to 3.3-4.4:1 as text; the ink is the colour a rung deeper in
// the same hue. The dark palettes keep the colour itself, which already clears
// the floor on their own tints.
describe("pill inks", () => {
  /** Every role a pill writes, paired with the token its tint is mixed from.
      The accent ink is the one drawn on the solid --accent-soft as well. */
  const PILLS = [
    { ink: "--green-ink", tint: "--green" },
    { ink: "--yellow-ink", tint: "--yellow" },
    { ink: "--red-ink", tint: "--red" },
    { ink: "--accent-ink", tint: "--accent" },
    { ink: "--panel-session-ink", tint: "--panel-session" },
    { ink: "--panel-sender-ink", tint: "--panel-sender" },
    { ink: "--panel-filer-ink", tint: "--panel-filer" },
  ] as const;

  // Both strengths the rules use (the transfer pills hold 10%, the badges and
  // the tab workspace pill 12%), because the weaker tint is the harder case on
  // the light canvases and the stronger one is the harder case on the dark.
  // --bg-app is the base: it is the worse of the two surfaces a pill sits on in
  // every palette — the tab strip paints the accent pill on it, and it is
  // lighter than --bg-panel in serialx-dark.
  it("clears 4.5:1 on the tint it is written on", () => {
    for (const mode of MODES) {
      for (const pill of PILLS) {
        for (const percent of [0.1, 0.12]) {
          const surface = tint(token(mode, pill.tint), percent, token(mode, "--bg-app"));
          expect(
            contrast(token(mode, pill.ink), surface),
            `${mode} ${pill.ink} on a ${percent * 100}% ${pill.tint} tint`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  // .filer-action.is-open paints the accent on the solid --accent-soft rather
  // than on a tint, and that surface is the palest one the accent ink meets.
  it("clears 4.5:1 on the solid accent tint", () => {
    for (const mode of MODES) {
      expect(
        contrast(token(mode, "--accent-ink"), token(mode, "--accent-soft")),
        `${mode} --accent-ink on --accent-soft`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // .panel-badge ("ssh" / "local") writes --fg-faint on the raised surface. It
  // used to sit on a tint of --fg: one strong enough to read as a chip pushed
  // the faint ink under 4.5:1 on the light canvases, and one weak enough to
  // pass there was invisible on the dark ones.
  it("keeps the protocol badge readable on the raised surface", () => {
    for (const mode of MODES) {
      expect(
        contrast(token(mode, "--fg-faint"), token(mode, "--bg-panel-alt")),
        `${mode} --fg-faint on --bg-panel-alt`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// serialx-light's semantic colours and its directory names carry text rather
// than decoration: the power button's "connected", every success state, the
// error ink, and the file lists' directory names at 11-12px weight 600, which
// earns no large-text exemption. They were mid-tones on the warm paper
// (4.10-4.39:1); the VS Code light half's deeper values were the reference for
// the rung below.
describe("serialx-light semantic text", () => {
  const mode: ThemeMode = "serialx-light";

  it("clears 4.5:1 on every surface it is written on", () => {
    const surfaces = ["--bg-app", "--bg-panel", "--bg-panel-alt", "--bg-terminal", "--bg-hover"];
    for (const name of ["--green", "--red", "--dir-label"]) {
      for (const surface of surfaces) {
        expect(
          contrast(token(mode, name), token(mode, surface)),
          `${mode} ${name} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
