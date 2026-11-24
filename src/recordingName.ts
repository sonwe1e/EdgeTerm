/**
 * The profile name as a recording file starts: the same rule the backend
 * applies (record, then clean, then trim). The Name field is free text, so
 * showing it unchanged promised a file that cannot exist — a profile called
 * "db: prod" was shown as `db: prod_<date>_<time>.log` while the writer
 * produced `db_ prod_20261124_143107.log`.
 */
const MAX_STEM_CHARS = 64;
const ILLEGAL = new Set([":", "/", "*", "?", '"', "<", ">", "|"]);
const BACKSLASH = 0x5c;

export function recordingStem(name: string): string {
  let cleaned = "";
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    const illegal = code < 0x20 || code === 0x7f || code === BACKSLASH || ILLEGAL.has(character);
    cleaned += illegal ? "_" : character;
  }
  const trimmedStart = cleaned.replace(/^[.\s]+/u, "");
  const limited = Array.from(trimmedStart).slice(0, MAX_STEM_CHARS).join("");
  const stem = limited.replace(/[.\s]+$/u, "");
  return stem === "" ? "session" : stem;
}
