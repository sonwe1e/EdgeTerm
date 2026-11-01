import type {
  IBuffer,
  IBufferLine,
  IBufferRange,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";

/**
 * File paths printed by a command belong to the working directory the shell was
 * in when that line was printed, which is not necessarily the directory it is
 * in now: a traceback keeps sitting in the scrollback after the user moved on.
 * Shells announce their directory at every prompt (OSC 7 / 1337 / 9;9), so
 * CwdAttribution keeps those reports and the link provider asks it which one
 * was in effect at the clicked line.
 *
 * Reports are keyed by a stable line number supplied by the caller. xterm moves
 * every buffer index down when the scrollback drops its oldest lines and
 * exposes no trim count through the public API, so the caller adds the number
 * of dropped lines once (TerminalLineGutter.firstLineNumber) and passes the
 * same coordinate to record and resolve. This module never reads the buffer
 * itself, which keeps the attribution pure and testable.
 */

/** One clickable file path found in a line of terminal output. */
export interface FileLinkMatch {
  /** Offset of the first character of the reference in the line text. */
  start: number;
  /**
   * Characters between start and the end of the printed reference. For a
   * path:line[:column] token this includes the suffix so the whole reference
   * can be underlined and clicked; the line number itself is in line.
   */
  length: number;
  /** The path as printed, without quotes, brackets or the line suffix. */
  path: string;
  /** 1-based line number from a traceback or a path:line suffix. */
  line?: number;
}

/** Longest path accepted; longer tokens are log noise, not file references. */
export const MAX_FILE_PATH_LENGTH = 1024;

/** Line numbers above this are not source references (path:99999999). */
export const MAX_FILE_LINE = 10_000_000;

/** How many directory reports are kept for attribution. */
export const CWD_REPORT_LIMIT = 200;

/**
 * Extensions that make a bare filename a file reference without a directory or
 * a line suffix. Version strings (1.2.3), abbreviations (e.g) and host:port
 * pairs are the false positives this list exists to suppress.
 */
const BARE_FILE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "ipynb",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "log",
  "lua",
  "md",
  "mjs",
  "php",
  "pl",
  "proto",
  "ps1",
  "py",
  "pyi",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/** Python tracebacks: File "/srv/train.py", line 238; single quotes too. */
const TRACEBACK = /\bFile\s+(?:"([^"\n]+)"|'([^'\n]+)')(?:,\s*line\s+(\d+))?/g;

/** Quoted strings; a path may sit in one and may contain spaces there. */
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'/g;

/** One whitespace-delimited token, with quoting and brackets removed. */
const TOKEN = /[^\s"'()\[\]{}<>|;,]+/g;

/** Characters trimmed from the start of a scanned value (flag, padding). */
const LEADING_JUNK = "=- ";

/** Characters trimmed from the end of a scanned value (sentence punctuation, padding). */
const TRAILING_JUNK = ".,;:!? ";

interface Span {
  start: number;
  end: number;
}

interface PrintedPath {
  path: string;
  line?: number;
  /** Offset of the path inside the scanned value. */
  offset: number;
  /** Printed reference length, including a line/column suffix. */
  length: number;
}

function hasAnyExtension(path: string): boolean {
  return /\.[A-Za-z0-9_]{1,12}$/.test(path);
}

function isKnownBareFile(path: string): boolean {
  const match = /\.([A-Za-z0-9_]{1,12})$/.exec(path);
  return match !== null && BARE_FILE_EXTENSIONS.has(match[1].toLowerCase());
}

/**
 * Whether a token is a path we can act on. Linux-shaped references only: the
 * commands whose output we link run on the server, so a Windows-looking or URL
 * token is either another kind of link or prose.
 */
function looksLikePath(path: string, hasLine: boolean): boolean {
  if (!path || path.length > MAX_FILE_PATH_LENGTH) return false;
  if (path.includes("\\") || path.includes(":")) return false;
  // A quoted absolute path may contain spaces; a relative one that does is
  // more likely a quoted sentence that mentions a path.
  if (/\s/.test(path) && !path.startsWith("/") && !path.startsWith("./")) return false;
  if (path.startsWith("//") || path.includes("://")) return false;
  if (path.endsWith("/")) return false;
  const lastSlash = path.lastIndexOf("/");
  const lastSegment = path.slice(lastSlash + 1);
  if (!lastSegment) return false;
  // An absolute path names a file even without an extension (/etc/hosts).
  if (path.startsWith("/")) return true;
  if (path.startsWith("./") || path.startsWith("../")) return true;
  // ~/ is left alone: it is not relative to the working directory and this
  // module cannot expand it.
  if (path.startsWith("~/")) return false;
  if (lastSlash >= 0) return hasAnyExtension(path) || hasLine;
  return isKnownBareFile(path);
}

/**
 * Reads one printed token into the path it names and the line it points at.
 * The suffix of a grep hit (path:line:column:text) is recognized so the line
 * number survives, but only the reference itself is part of the link.
 */
function readPathToken(value: string): PrintedPath | null {
  let start = 0;
  // A flag can carry the path: --output=/srv/run.log.
  const assignment = /^-{1,2}[A-Za-z0-9_.-]+=/.exec(value);
  if (assignment) start = assignment[0].length;
  while (start < value.length && LEADING_JUNK.includes(value[start])) start++;
  let end = value.length;
  while (end > start && TRAILING_JUNK.includes(value[end - 1])) end--;
  if (start >= end) return null;
  const token = value.slice(start, end);
  const suffix = /^(.*?)(?::(\d+))(?::(\d+))?(?::(\S+))?$/.exec(token);
  if (suffix && suffix[1]) {
    const line = Number(suffix[2]);
    if (!Number.isSafeInteger(line) || line < 1 || line > MAX_FILE_LINE) return null;
    const path = suffix[1];
    if (!looksLikePath(path, true)) return null;
    // A trailing :text belongs to the surrounding output, not to the link.
    const trailing = suffix[4] ? suffix[4].length + 1 : 0;
    return { path, line, offset: start, length: token.length - trailing };
  }
  if (!looksLikePath(token, false)) return null;
  return { path: token, offset: start, length: token.length };
}

/**
 * Every clickable file reference in one line of terminal output.
 *
 * Recognised: Python tracebacks (File "...", line N), path:line,
 * path:line:column, relative paths and paths wrapped in quotes or brackets.
 * Not recognised: http(s) URLs (the web-links addon owns those), Windows
 * paths, bare a:b tokens without an extension or directory, line numbers above
 * MAX_FILE_LINE and very long tokens.
 */
export function parseFileLinks(lineText: string): FileLinkMatch[] {
  if (!lineText) return [];
  const found: FileLinkMatch[] = [];
  const claimed: Span[] = [];
  const overlapsClaim = (start: number, length: number): boolean => {
    const end = start + length;
    return claimed.some((span) => start < span.end && span.start < end);
  };
  const claim = (start: number, length: number) => {
    claimed.push({ start, end: start + length });
  };
  const push = (tokenStart: number, parsed: PrintedPath, printedLine?: number) => {
    const line = parsed.line ?? printedLine;
    const match: FileLinkMatch = {
      start: tokenStart + parsed.offset,
      length: parsed.length,
      path: parsed.path,
    };
    if (line !== undefined) match.line = line;
    found.push(match);
  };

  // A traceback names the file and the line on the same row, and the path may
  // contain spaces because it is quoted.
  for (const match of lineText.matchAll(TRACEBACK)) {
    const content = match[1] ?? match[2];
    if (content === undefined) continue;
    const contentStart = (match.index ?? 0) + match[0].lastIndexOf(content);
    const tracebackLine = match[3] === undefined ? undefined : Number(match[3]);
    if (
      tracebackLine !== undefined &&
      (!Number.isSafeInteger(tracebackLine) || tracebackLine < 1 || tracebackLine > MAX_FILE_LINE)
    ) {
      // A line number that cannot be right makes the reference unusable; the
      // quoted fallback below must not turn it into a link without the line.
      claim(contentStart, content.length);
      continue;
    }
    const parsed = readPathToken(content);
    if (!parsed) continue;
    push(contentStart, parsed, tracebackLine);
    claim(contentStart + parsed.offset, parsed.length);
  }

  // Quoted paths: the whole string is one path, so spaces survive; a quoted
  // message with a path inside it falls back to scanning the string.
  for (const match of lineText.matchAll(QUOTED)) {
    const content = match[1] ?? match[2];
    if (content === undefined) continue;
    const contentStart = (match.index ?? 0) + 1;
    if (overlapsClaim(contentStart, content.length)) continue;
    const whole = readPathToken(content);
    if (whole) {
      push(contentStart, whole);
    } else {
      for (const token of content.matchAll(TOKEN)) {
        const parsed = readPathToken(token[0]);
        if (parsed) push(contentStart + (token.index ?? 0), parsed);
      }
    }
    claim(contentStart, content.length);
  }

  // Everything else: whitespace-delimited tokens outside the quoted spans.
  for (const token of lineText.matchAll(TOKEN)) {
    const start = token.index ?? 0;
    if (overlapsClaim(start, token[0].length)) continue;
    const parsed = readPathToken(token[0]);
    if (parsed) push(start, parsed);
  }

  found.sort((left, right) => left.start - right.start || right.length - left.length);
  const result: FileLinkMatch[] = [];
  for (const match of found) {
    const previous = result[result.length - 1];
    if (previous && match.start < previous.start + previous.length) continue;
    result.push(match);
  }
  return result;
}

interface CwdReport {
  line: number;
  cwd: string;
}

/**
 * Remembers which directory was in effect for a stable line of output.
 *
 * A report is emitted at the prompt, so it covers everything printed after it;
 * resolving asks for the last report at or before the line. Old reports are
 * dropped once the cap is reached so a long session cannot grow this without
 * bound, and the caller resets it when the buffer they describe is erased.
 */
export class CwdAttribution {
  private reports: CwdReport[] = [];

  /** Records the directory the shell announced for a stable line. */
  record(stableLine: number, cwd: string): void {
    if (!Number.isFinite(stableLine) || stableLine < 0 || cwd.length === 0) return;
    const last = this.reports[this.reports.length - 1];
    if (last && last.line === stableLine) {
      last.cwd = cwd;
      return;
    }
    this.reports.push({ line: stableLine, cwd });
    if (this.reports.length > CWD_REPORT_LIMIT) {
      this.reports.splice(0, this.reports.length - CWD_REPORT_LIMIT);
    }
  }

  /** The directory reported for the last report at or before the line. */
  resolve(stableLine: number): string | null {
    if (!Number.isFinite(stableLine)) return null;
    for (let index = this.reports.length - 1; index >= 0; index--) {
      const report = this.reports[index];
      if (report.line <= stableLine) return report.cwd;
    }
    return null;
  }

  /** Forgets every report; the buffer they described is gone. */
  reset(): void {
    this.reports = [];
  }
}

/** What the provider asks the embedder to open. */
export interface TerminalFileLinkTarget {
  path: string;
  line?: number;
  /** The directory in effect for the line; null for an absolute path. */
  cwd: string | null;
}

export interface FileLinkProviderOptions {
  /** The terminal the provider is registered on. */
  terminal: Terminal;
  /**
   * Directory in effect for a 1-based xterm buffer line, or null when the
   * shell never reported one. The callback owns the conversion to the stable
   * line the attribution recorded with.
   */
  getCwdForLine: (bufferLineNumber: number) => string | null;
  /** Opens a reference; only reached on an explicit Ctrl/Cmd click. */
  openLink: (target: TerminalFileLinkTarget) => void;
  /** True while a full-screen program owns the mouse (a TUI). */
  isMouseTracking: () => boolean;
}

/**
 * xterm link provider for file paths in terminal output.
 *
 * Activation follows the web-links addon's convention: only Ctrl (or Cmd on
 * macOS) turns a click into an action, so a plain click keeps selecting text
 * and a modified click inside a TUI stays with the program. Hovering parses
 * text only; reading the file happens in the embedder's openLink, on the click.
 */
export function createFileLinkProvider(options: FileLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      if (options.isMouseTracking()) {
        callback(undefined);
        return;
      }
      const buffer = options.terminal.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const matches = parseFileLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      // A long path can be split across wrapped rows; a match that is clipped
      // by the row edge would open a fragment, so it stays unlinked.
      const following = buffer.getLine(bufferLineNumber);
      const clippedLeft = line.isWrapped;
      const clippedRight = Boolean(following && following.isWrapped);
      const links: ILink[] = [];
      for (const match of matches) {
        if (clippedLeft && match.start === 0) continue;
        if (clippedRight && match.start + match.length === text.length) continue;
        const range = linkRange(buffer, line, bufferLineNumber, match);
        if (!range) continue;
        links.push({
          range,
          text: text.slice(match.start, match.start + match.length),
          activate: (event: MouseEvent) =>
            activateFileLink(options, bufferLineNumber, match, event),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * The buffer range of a match in the coordinates xterm hit-tests and
 * underlines with: x is 1-based and counts display columns, so a wide (CJK)
 * character before the path shifts it by two, and y is the 1-based buffer
 * line.
 */
function linkRange(
  buffer: IBuffer,
  line: IBufferLine,
  bufferLineNumber: number,
  match: FileLinkMatch,
): IBufferRange | null {
  const cell = buffer.getNullCell();
  const firstOffset = match.start;
  const lastOffset = match.start + match.length - 1;
  let startColumn = 0;
  let endColumn = 0;
  let characters = 0;
  let columns = 0;
  for (let index = 0; index < line.length; index++) {
    const current = line.getCell(index, cell);
    if (!current) break;
    const width = current.getWidth();
    if (width === 0) continue;
    const chars = current.getChars();
    const charCount = chars.length || 1;
    const cellBegin = characters;
    const cellEnd = characters + charCount;
    if (startColumn === 0 && cellBegin <= firstOffset && firstOffset < cellEnd) {
      startColumn = columns + 1;
    }
    if (cellBegin <= lastOffset && lastOffset < cellEnd) {
      endColumn = columns + width;
      break;
    }
    characters = cellEnd;
    columns += width;
  }
  if (startColumn === 0 || endColumn === 0) return null;
  return {
    start: { x: startColumn, y: bufferLineNumber },
    end: { x: endColumn, y: bufferLineNumber },
  };
}

function activateFileLink(
  options: FileLinkProviderOptions,
  bufferLineNumber: number,
  match: FileLinkMatch,
  event: MouseEvent,
): void {
  if (event.button !== 0) return;
  if (!event.ctrlKey && !event.metaKey) return;
  // A program that owns the mouse gets the click: Ctrl+click in a TUI is the
  // program's to interpret, not a file to open behind it.
  if (options.isMouseTracking()) return;
  const line = options.terminal.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) return;
  // Output may have scrolled or rewritten the row between hover and click; a
  // reference that is no longer printed there is stale and must not open.
  const fresh = parseFileLinks(line.translateToString(true)).find(
    (candidate) => candidate.start === match.start && candidate.path === match.path,
  );
  if (!fresh) return;
  event.preventDefault();
  const target: TerminalFileLinkTarget = {
    path: fresh.path,
    cwd: fresh.path.startsWith("/") ? null : options.getCwdForLine(bufferLineNumber),
  };
  if (fresh.line !== undefined) target.line = fresh.line;
  options.openLink(target);
}
