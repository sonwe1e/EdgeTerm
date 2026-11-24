/**
 * The folder to blame in a failed connect, or null when recording is off.
 *
 * The recording folder is created before the transport starts, so an unusable
 * one aborts the whole connect while the headline says to check the address,
 * port, network and credentials. Naming the folder under that headline is what
 * puts the cause beside the field that owns it.
 */
export function blamedRecordingFolder(
  profile: { record?: boolean; recordDir?: string | null },
  fallback: string,
): string | null {
  if (!profile.record) return null;
  const path = profile.recordDir?.trim() || fallback.trim();
  return path === "" ? null : path;
}
