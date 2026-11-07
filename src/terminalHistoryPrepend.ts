import type { Terminal } from "@xterm/xterm";

/**
 * A2-5 spike (D14): prepending reconstructed history lines into a live xterm
 * buffer. xterm's public API cannot insert above the buffer top, but its own
 * InputHandler scrolls the scroll region through
 * `CircularList.splice(0, 0, ...lines)`, and `ybase`/`ydisp` are writable —
 * the renderer draws from `ydisp`. This module reaches those internals with
 * the same defensive discipline as `semanticPaint`: every internal shape is
 * validated at call time, and any mismatch returns 0 prepended lines instead
 * of corrupting the buffer, so an xterm upgrade can only disable seamless
 * history, never crash the terminal.
 *
 * The buffer's own trims run from the oldest end, so a prepended line is the
 * first thing a later trim removes — the hot window stays bounded. Callers
 * keep the viewport stable by adding the prepended count to `ydisp`
 * themselves (see `shiftViewport`), and must clear selections before
 * prepending (the selection service tracks trims, not insertions).
 */

/** The internal line list xterm's own InputHandler splices into. */
interface LineList {
  length: number;
  maxLength: number;
  splice(start: number, deleteCount: number, ...items: unknown[]): unknown[];
  get(index: number): { clone(): unknown } | undefined;
}

interface BufferInternals {
  lines: LineList;
  ydisp: number;
  ybase: number;
}

type Core = { _bufferService?: { buffer?: BufferInternals } };

/** The splice-capable list behind the normal buffer, or null if absent. */
export function internalList(term: Terminal): LineList | null {
  const core = (term as unknown as { _core?: Core })._core;
  const buffer = core?._bufferService?.buffer;
  const list = buffer?.lines;
  if (!list || typeof list.splice !== "function" || typeof list.get !== "function") return null;
  if (!Number.isInteger(list.length) || !Number.isInteger(list.maxLength)) return null;
  return list;
}

/**
 * Prepends `count` clones of the line at `sourceIndex` (0 = oldest line) to
 * the top of the normal buffer, growing the list capacity first so the
 * splice's own overflow trim cannot eat what it just inserted. Returns the
 * number of lines actually prepended; 0 means the internals were missing and
 * the caller must fall back (the spike's answer to "is route A viable on this
 * xterm build").
 */
export function prependClonedLines(term: Terminal, sourceIndex: number, count: number): number {
  const list = internalList(term);
  if (!list || count <= 0) return 0;
  const source = list.get(sourceIndex);
  if (!source || typeof source.clone !== "function") return 0;
  const clones: unknown[] = [];
  for (let index = 0; index < count; index++) clones.push(source.clone());
  // CircularList.splice mutates in place (it is not Array.splice and returns
  // nothing), so correctness is checked through the length delta.
  const lengthBefore = list.length;
  // CircularList.splice trims from the oldest end when the insertion would
  // exceed maxLength, so the capacity must grow first (CircularList.ts:178).
  list.maxLength += count;
  list.splice(0, 0, ...clones);
  if (list.length !== lengthBefore + count) return 0;
  return count;
}

/**
 * Moves the viewport down by `count` lines so the same content stays on
 * screen across a prepend. Returns true when the shift was applied.
 */
export function shiftViewport(term: Terminal, count: number): boolean {
  const core = (term as unknown as { _core?: Core })._core;
  const buffer = core?._bufferService?.buffer;
  if (!buffer || !Number.isInteger(buffer.ydisp)) return false;
  buffer.ydisp += count;
  return true;
}
