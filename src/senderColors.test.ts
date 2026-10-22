import { describe, expect, it } from "vitest";

import { CATALOGS } from "./i18n";
import {
  SENDER_COLORS,
  senderColor,
  senderColorLabelKey,
  senderColorStyle,
  senderColorValue,
} from "./senderColors";

describe("sender tag colors", () => {
  it("accepts only the palette names this build paints", () => {
    for (const color of SENDER_COLORS) expect(senderColor(color)).toBe(color);
    // A name from a newer build loads untinted instead of failing the file.
    expect(senderColor("chartreuse")).toBeNull();
    expect(senderColor("")).toBeNull();
    expect(senderColor(null)).toBeNull();
    expect(senderColor(undefined)).toBeNull();
  });

  it("points swatches and tag styles at the theme tokens", () => {
    expect(senderColorValue("teal")).toBe("var(--tag-teal)");
    expect(senderColorStyle("red")).toEqual({ "--tag-color": "var(--tag-red)" });
    expect(senderColorStyle("chartreuse")).toBeUndefined();
    expect(senderColorStyle(null)).toBeUndefined();
  });

  it("labels every palette entry through the prepared messages", () => {
    for (const color of SENDER_COLORS) {
      const key = senderColorLabelKey(color);
      expect(key.startsWith("sender.color"), key).toBe(true);
      // The catalog stays the source of the wording; this catches a key that
      // points at another color's label.
      expect(CATALOGS.en[key].toLowerCase()).toBe(color);
    }
  });
});
