/**
 * Bounded error recognition for the run log: a Python traceback frame line
 * becomes a jump target only when it names a real file and line. Everything
 * else — progress bars, metrics, stack frames inside `<stdin>`/`<frozen …>`,
 * Windows drive paths — stays plain text.
 */

/** Where the click should land: an absolute remote path and a 1-based line. */
export interface LogJump {
  path: string;
  line: number;
}

export interface LogLine {
  text: string;
  jump: LogJump | null;
}

export interface ParsedLog {
  /** Older text, kept as one plain node; only the tail is interactive. */
  head: string;
  lines: LogLine[];
}

/** How many trailing lines can carry a link. Long logs stay cheap to render. */
export const INTERACTIVE_TAIL_LINES = 200;

/** `File "warp.py", line 138, in forward` — the traceback frame format. */
const FRAME = /^\s*File "([^"]+)", line (\d+)/;

/** Paths Python reports but no editor can open: `<stdin>`, `<string>`, … */
function isOpenable(path: string): boolean {
  if (path.startsWith("<")) return false;
  // A drive-letter path belongs to a Windows process; the remote editor
  // addresses files with POSIX separators, so resolving it would be a lie.
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return path.length > 0;
}

/** A relative frame path is resolved against the run's project source root. */
export function resolveJumpPath(raw: string, root: string | null | undefined): string | null {
  if (raw.startsWith("/")) return raw;
  if (!root) return null;
  return `${root.replace(/\/+$/, "")}/${raw}`;
}

/**
 * Splits the log into a plain head and interactive tail lines. The tail bound
 * keeps rendering cost predictable for a 512 KiB view; the patterns stay the
 * same no matter where in the file the error appeared.
 */
export function parseLogForJumps(
  log: string,
  root: string | null | undefined,
  tailLines: number = INTERACTIVE_TAIL_LINES,
): ParsedLog {
  if (!log) return { head: "", lines: [] };
  const all = log.split("\n");
  const start = Math.max(0, all.length - tailLines);
  const head = start > 0 ? `${all.slice(0, start).join("\n")}\n` : "";
  const lines: LogLine[] = [];
  for (const text of all.slice(start)) {
    let jump: LogJump | null = null;
    const match = FRAME.exec(text);
    if (match) {
      const path = resolveJumpPath(match[1], root);
      if (path && isOpenable(match[1])) {
        const line = Number.parseInt(match[2], 10);
        if (Number.isFinite(line) && line > 0) jump = { path, line };
      }
    }
    lines.push({ text, jump });
  }
  return { head, lines };
}
