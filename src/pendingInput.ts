/**
 * Keystrokes typed while a session is still connecting.
 *
 * The terminal accepts input as soon as the tab exists, but the backend has no
 * session to write to until the handshake finishes: without a buffer those
 * bytes were dropped by `writeSession` and the user saw keystrokes that did
 * nothing, with no hint that they were lost. They are held here instead and
 * sent once the backend reports the session connected.
 *
 * Nothing is echoed while they wait — the remote side echoes input, and there
 * is no remote side yet — so this preserves what was typed, it does not make
 * the terminal look live.
 */
const pending = new Map<string, string>();

/** The most that waits for one session, so a stuck connect cannot grow for ever. */
export const PENDING_INPUT_LIMIT = 64 * 1024;

/**
 * Holds `data` for `id` until it connects. Past the limit the oldest bytes are
 * dropped: a shell that eventually runs should get the recent end of what the
 * user typed, not the whole of an accidental paste.
 */
export function bufferPendingInput(id: string, data: string): void {
  if (!data) return;
  const combined = (pending.get(id) ?? "") + data;
  pending.set(
    id,
    combined.length > PENDING_INPUT_LIMIT
      ? combined.slice(combined.length - PENDING_INPUT_LIMIT)
      : combined,
  );
}

/** The input waiting for `id`, if any, and forgets it. */
export function takePendingInput(id: string): string | null {
  const data = pending.get(id);
  pending.delete(id);
  return data && data.length > 0 ? data : null;
}

/** Forgets what was typed for `id`: the attempt failed, or the tab is gone. */
export function clearPendingInput(id: string): void {
  pending.delete(id);
}
