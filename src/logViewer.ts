import type { LogWindow } from "./api";

export const LOG_WINDOW_BYTES = 256 * 1024;
export const MAX_LOG_MATCHES = 100;

/** Search only the current, bounded window. Keywords are literal, not regex. */
export function logMatches(content: string, query: string, limit = MAX_LOG_MATCHES): number[] {
  if (!query || limit <= 0) return [];
  const matches: number[] = [];
  let from = 0;
  while (matches.length < limit) {
    const found = content.indexOf(query, from);
    if (found < 0) break;
    matches.push(found);
    from = found + Math.max(1, query.length);
  }
  return matches;
}

export type FollowDecision = "idle" | "append" | "reload" | "rotated" | "replaced";

/** Decide without touching file contents. The caller owns the SFTP reads. */
export function classifyLogFollow(previous: LogWindow, next: LogWindow): FollowDecision {
  if (next.size < previous.end || next.end < previous.end) return "rotated";
  if (next.end > previous.end) {
    if (
      next.start !== previous.end ||
      next.end < next.size ||
      next.end - previous.start > LOG_WINDOW_BYTES
    ) {
      return "reload";
    }
    return "append";
  }
  if (
    next.modifiedAt !== null &&
    previous.modifiedAt !== null &&
    next.modifiedAt !== previous.modifiedAt
  ) {
    return "replaced";
  }
  return "idle";
}
