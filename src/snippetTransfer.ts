import { MAX_COMMAND_LENGTH, MAX_NAME_LENGTH, MAX_SNIPPETS, type Snippet } from "./snippets";

/**
 * Saved commands travel as one small JSON document, on the clipboard or in a
 * file: names and commands only. Ids are local bookkeeping and would collide
 * on the machine that receives them.
 */
const SNIPPETS_FORMAT = "edgeterm-snippets";
const SNIPPETS_VERSION = 1;

interface SnippetEntry {
  name: string;
  command: string;
}

type ImportFailure = "not-json" | "wrong-format" | "empty";

type ImportResult =
  | { ok: true; entries: SnippetEntry[]; skipped: number }
  | { ok: false; reason: ImportFailure };

/** The clipboard text for a whole list: pretty JSON, so it stays readable. */
export function exportSnippets(snippets: readonly Snippet[]): string {
  const body = {
    format: SNIPPETS_FORMAT,
    version: SNIPPETS_VERSION,
    snippets: snippets.map((snippet) => ({ name: snippet.name, command: snippet.command })),
  };
  return JSON.stringify(body, null, 2);
}

const cleaned = (entry: unknown): SnippetEntry | null => {
  if (typeof entry !== "object" || entry === null) return null;
  const { name, command } = entry as { name?: unknown; command?: unknown };
  if (typeof name !== "string" || typeof command !== "string") return null;
  const trimmed = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const text = command.slice(0, MAX_COMMAND_LENGTH);
  if (!trimmed || !text.trim()) return null;
  return { name: trimmed, command: text };
};

/**
 * Reads a bundle back. Unknown shapes are refused as a whole rather than
 * partly imported: a half-restored list looks like success and is not.
 */
export function importSnippets(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "wrong-format" };
  const bundle = parsed as { format?: unknown; snippets?: unknown };
  if (bundle.format !== SNIPPETS_FORMAT || !Array.isArray(bundle.snippets)) {
    return { ok: false, reason: "wrong-format" };
  }
  const entries: SnippetEntry[] = [];
  let skipped = 0;
  for (const raw of bundle.snippets.slice(0, MAX_SNIPPETS)) {
    const entry = cleaned(raw);
    if (!entry) {
      skipped += 1;
      continue;
    }
    // Last one wins: a bundle that repeats a name means the later command.
    const existing = entries.findIndex((item) => item.name === entry.name);
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
  }
  if (entries.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, entries, skipped };
}
