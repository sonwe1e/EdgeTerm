/**
 * Lines worth noticing while a log scrolls: errors and warnings. The gutter
 * tints the rows that carry them, so a build log that scrolled past its one
 * failure stays findable without re-reading the whole history.
 *
 * The vocabulary is deliberately small and fixed. A configurable watch list
 * would need its own settings surface, and a program that prints "error" in a
 * normal sentence ("0 errors") is already excluded by the word boundary and
 * the singular/plural distinction below.
 */
export type WatchSeverity = "error" | "warn";

const ERROR_WORDS = /\b(?:error|fatal|panic|failed|failure|exception)\b/i;
const WARN_WORDS = /\b(?:warn|warning|deprecated|retry|retrying|timed out|timeout)\b/i;

/** Which mark a line earns, if any. An error outranks a warning on one line. */
export function watchSeverity(line: string): WatchSeverity | null {
  if (!line) return null;
  // Plural nouns are reports, not failures: "0 errors" and "warnings: 2"
  // would otherwise mark a clean run. The regexes' word boundaries already
  // reject "errors"/"warnings", so nothing extra is needed here.
  if (ERROR_WORDS.test(line)) return "error";
  if (WARN_WORDS.test(line)) return "warn";
  return null;
}
