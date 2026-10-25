import { iterateMatches, SEARCH_HIGHLIGHT_LIMIT } from "./terminalSearch";

/** Character offsets in a logical (possibly wrapped) terminal line. */
export interface RegexPosition {
  row: number;
  offset: number;
}

export interface RegexMatch {
  row: number;
  start: number;
  end: number;
}

export interface RegexRequest {
  source: string;
  flags: string;
  wholeWord: boolean;
  lines: { row: number; text: string; min: number; max: number }[];
  selection: { start: RegexPosition; end: RegexPosition } | null;
  forward: boolean;
  incremental: boolean;
  /** Output refresh keeps the current match, without selecting another one. */
  refresh: boolean;
}

export interface RegexResponse {
  matches: RegexMatch[];
  target: RegexMatch | null;
}

const compare = (match: RegexMatch, position: RegexPosition) =>
  match.row - position.row || match.start - position.offset;

/** Runs only in the worker in production; never evaluate arbitrary regexes on the UI thread. */
export function searchRegex(request: RegexRequest): RegexResponse {
  const pattern = new RegExp(request.source, request.flags);
  const matches: RegexMatch[] = [];
  let first: RegexMatch | null = null;
  let last: RegexMatch | null = null;
  let target: RegexMatch | null = null;
  let atSelection: RegexMatch | null = null;
  const selection = request.selection;
  const from = request.incremental ? selection?.start : selection?.end;
  for (const line of request.lines) {
    for (const [start, end] of iterateMatches(line.text, pattern, request.wholeWord)) {
      if (start < line.min || end > line.max) continue;
      const match = { row: line.row, start, end };
      first ??= match;
      last = match;
      if (matches.length < SEARCH_HIGHLIGHT_LIMIT) matches.push(match);
      if (selection && compare(match, selection.start) === 0) atSelection = match;
      if (request.forward) {
        if (!target && (!from || compare(match, from) >= 0)) target = match;
      } else if (!selection || compare(match, selection.start) < 0) {
        target = match;
      }
    }
  }
  if (request.refresh) {
    target =
      atSelection &&
      selection &&
      atSelection.row === selection.end.row &&
      atSelection.end === selection.end.offset
        ? atSelection
        : null;
  } else if (!request.forward) {
    target = (request.incremental ? atSelection : null) ?? target ?? last;
  } else {
    target ??= first;
  }
  return { matches, target };
}
