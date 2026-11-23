/**
 * Saved commands: the ones a reader runs over and over ("tail the app log",
 * "restart nginx"). A snippet is just a name and a line of shell text — it is
 * stored in the browser, sent through the same input funnel as typing, and
 * never executed by the app itself.
 */

import { SNIPPETS_STORAGE_KEY } from "./persistKeys";

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export const SNIPPETS_KEY = SNIPPETS_STORAGE_KEY;

/** Enough for any real workflow, small enough to keep the dialog readable. */
export const MAX_SNIPPETS = 100;

/** A command line, not a script: anything longer belongs in a file on the host. */
export const MAX_COMMAND_LENGTH = 4_000;

export const MAX_NAME_LENGTH = 60;

const isSnippet = (value: unknown): value is Snippet => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.command === "string"
  );
};

/**
 * Reads the stored list. Anything malformed is dropped rather than repaired:
 * a snippet the reader cannot see or send is better than a command that was
 * silently rewritten.
 */
export function parseSnippets(raw: string | null): Snippet[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const snippets: Snippet[] = [];
  for (const value of parsed) {
    if (!isSnippet(value)) continue;
    const name = value.name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, MAX_NAME_LENGTH);
    const command = value.command.slice(0, MAX_COMMAND_LENGTH);
    if (!name || !command.trim() || seen.has(value.id)) continue;
    seen.add(value.id);
    snippets.push({ id: value.id, name, command });
    if (snippets.length >= MAX_SNIPPETS) break;
  }
  return snippets;
}

export function loadSnippets(): Snippet[] {
  try {
    return parseSnippets(localStorage.getItem(SNIPPETS_KEY));
  } catch {
    return [];
  }
}

export function saveSnippets(snippets: readonly Snippet[]): void {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    // Storage denied or full: the list still works for this session.
  }
}

/** A pending command as typed: no leading/trailing blanks, no stray CRs. */
export const cleanCommand = (command: string): string => command.replace(/\r\n?/g, "\n").trim();

/** What actually reaches the shell: the command and one Enter. */
export const snippetBytes = (command: string): string =>
  cleanCommand(command).replace(/\n/g, "\r") + "\r";

/**
 * Parameterised commands: `{{name}}` is filled in before the line is sent.
 * The delimiter is deliberately not the shell's `${VAR}` or `{}` from find/awk:
 * a snippet is mostly shell text, and guessing which braces are ours would
 * corrupt the ones that are not. Anything that does not close is literal.
 */
const PARAMETER = /\{\{([^{}]{1,40})\}\}/g;

/** The parameter names in a command, in first-seen order, without repeats. */
export function templateNames(command: string): string[] {
  const names: string[] = [];
  for (const match of command.matchAll(PARAMETER)) {
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Fills the parameters in. A value that was not supplied keeps its placeholder
 * visible — sending `deploy {{env}}` is safer than deploying to an empty string.
 */
export function expandTemplate(command: string, values: Record<string, string>): string {
  return command.replace(PARAMETER, (whole, rawName: string) => {
    const name = rawName.trim();
    const value = values[name];
    return value === undefined || value === "" ? whole : value;
  });
}
/**
 * A free name for a duplicate: the original's name plus a copy suffix, then
 * a counter until nothing takes it. Names are how snippets are found and
 * how a later save replaces one, so a duplicate must never silently
 * overwrite its source.
 */
export function copyName(name: string, taken: readonly Snippet[]): string {
  const names = new Set(taken.map((snippet) => snippet.name.toLowerCase()));
  const stem = name.trim().slice(0, MAX_NAME_LENGTH);
  // The suffix is appended to a stem shortened by exactly its own length.
  // Appending first and clipping after would, for a name already at the limit,
  // clip the copy straight back onto the original — and a save under a taken
  // name replaces that entry, so the "copy" would silently overwrite its source.
  const withSuffix = (suffix: string) =>
    stem.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trimEnd() + suffix;
  const free = (candidate: string) => candidate.length > 0 && !names.has(candidate.toLowerCase());

  const first = withSuffix(" copy");
  if (free(first)) return first;
  for (let count = 2; count <= taken.length + 2; count += 1) {
    const candidate = withSuffix(` copy ${count}`);
    if (free(candidate)) return candidate;
  }
  // Every counter below the list's length was taken; keep counting rather than
  // hand back a name that is already in use.
  for (let count = taken.length + 3; ; count += 1) {
    const candidate = withSuffix(` copy ${count}`);
    if (free(candidate)) return candidate;
  }
}
