import { describe, expect, it } from "vitest";

import {
  CATALOGS,
  detectLanguage,
  LANGUAGES,
  LANGUAGE_LABELS,
  type MessageKey,
  parseLanguage,
  translate,
} from "./i18n";

// The English catalog is the source of truth; its keys are the whole set.
const enKeys = Object.keys(CATALOGS.en).sort();

describe("interface localisation", () => {
  it("names every language in that language", () => {
    for (const language of LANGUAGES) {
      expect(LANGUAGE_LABELS[language], language).toBeTruthy();
    }
  });

  it("translates every message into every language, with no blanks", () => {
    for (const language of LANGUAGES) {
      const keys = Object.keys(CATALOGS[language]).sort();
      // The `Catalog` type already pins the key sets together at compile time;
      // this keeps a hand-edited catalog from silently dropping or blanking an
      // entry, and fails naming the offending language and key.
      expect(keys, language).toEqual(enKeys);
      for (const key of enKeys) {
        expect(
          translate(language, key as MessageKey).length,
          `${language}: ${key}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("fills {name} placeholders and leaves unknown ones as written", () => {
    expect(
      translate("en", "menu.panelOnDock", { panel: "Filer", dock: "Right" }),
    ).toBe("Filer on Right");
    expect(
      translate("zh-CN", "menu.panelOnDock", { panel: "文件", dock: "右侧" }),
    ).toBe("文件停靠到右侧");
    expect(translate("en", "menu.panelOnDock", { panel: "Filer" })).toBe(
      "Filer on {dock}",
    );
  });

  it("takes the interface language from the machine's, else English", () => {
    expect(detectLanguage(["zh-CN", "en"])).toBe("zh-CN");
    expect(detectLanguage(["zh-TW"])).toBe("zh-CN");
    expect(detectLanguage(["en-US"])).toBe("en");
    expect(detectLanguage(["fr-FR"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
  });

  it("accepts only the languages this build ships", () => {
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("zh-CN")).toBe("zh-CN");
    expect(parseLanguage("zh")).toBeNull();
    expect(parseLanguage("fr")).toBeNull();
    expect(parseLanguage(undefined)).toBeNull();
  });
});
