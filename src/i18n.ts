import { en } from "./locales/en";
import { zhCN } from "./locales/zhCN";

/**
 * Interface localisation. The English catalog in locales/en.ts is the single source of
 * truth: its keys define `MessageKey`, and every other language must supply a
 * value for each of them, which the compiler enforces (`Catalog`). English
 * text is kept byte-for-byte identical to what the interface showed before it
 * was moved here, so the existing tests that click and assert on English
 * labels keep passing; the other languages are additive.
 *
 * The module is deliberately dependency-free (it must not import the store,
 * which imports it). Imperative code that is not React — `actions.ts`, the
 * store's own status strings — calls the module-level `t`, which reads the
 * language the store last published through `setCurrentLanguage`. React
 * components use the `useT` hook (see useT.ts) so they re-render on a change.
 */

export type Language = "en" | "zh-CN";

/** Every language the interface can be shown in, in the order they are listed. */
export const LANGUAGES: readonly Language[] = ["en", "zh-CN"];

/**
 * Each language's own name, shown in the language switcher. A language is
 * always written in itself, the way browsers and operating systems list them.
 */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  "zh-CN": "简体中文",
};


export type MessageKey = keyof typeof en;

/** A full set of messages for one language; the compiler checks completeness. */
export type Catalog = Record<MessageKey, string>;


export const CATALOGS: Record<Language, Catalog> = {
  en,
  "zh-CN": zhCN,
};

/** Values substituted into a message's `{name}` placeholders. */
export type TParams = Record<string, string | number>;

/** A bound translator: `t(key)` or `t(key, { name })`. */
export type Translate = (key: MessageKey, params?: TParams) => string;

/** Fills a message's `{name}` placeholders; unknown ones are left as written. */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** The message for `key` in `language`, falling back to English, then the key. */
export function translate(
  language: Language,
  key: MessageKey,
  params?: TParams,
): string {
  const catalog = CATALOGS[language];
  const template = (catalog && catalog[key]) ?? en[key] ?? key;
  return interpolate(template, params);
}

/** A stored or imported language, or null when it is not one this build has. */
export const parseLanguage = (value: unknown): Language | null =>
  value === "en" || value === "zh-CN" ? value : null;

/**
 * The language to open with when nothing is stored: the interface language of
 * the machine, so a Chinese system gets Chinese without a trip to the menu.
 * Anything that is not Chinese falls back to English.
 */
export function detectLanguage(
  languages: readonly string[] = typeof navigator !== "undefined"
    ? navigator.languages ?? [navigator.language]
    : [],
): Language {
  return languages.some((tag) => tag.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

// The language imperative code translates with. The store mirrors its own
// `language` here on start-up and on every change (the same push pattern
// shortcuts.ts uses), so `actions.ts` and the store's status strings can call
// `t` without importing the store.
let activeLanguage: Language = "en";

export function setCurrentLanguage(language: Language): void {
  activeLanguage = language;
  // <html lang> is what screen readers use to pick a voice, and what the
  // stylesheet uses to drop Latin-only typographic devices (see :lang(zh)).
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}

/** Translator for non-React code; reads the store's published language. */
export const t: Translate = (key, params) =>
  translate(activeLanguage, key, params);
