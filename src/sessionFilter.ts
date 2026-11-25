/**
 * What the session list's filter box searches.
 *
 * A tree of saved sessions is usually remembered by machine, not by whatever
 * label was typed when it was saved, so the filter reads the name **and** how
 * the session connects: host, user, `user@host`, port, or a serial port name.
 * Matching any one of them is enough.
 */
interface FilterableProfile {
  name: string;
  host?: string | null;
  username?: string | null;
  port?: number | null;
  portName?: string | null;
}

/** Whether `profile` survives the filter box holding `needle`. */
export function sessionMatchesFilter(profile: FilterableProfile, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query === "") return true;
  const haystack = [
    profile.name,
    profile.host ?? "",
    profile.username ?? "",
    profile.portName ?? "",
    profile.port ? String(profile.port) : "",
  ];
  if (profile.username && profile.host) haystack.push(`${profile.username}@${profile.host}`);
  return haystack.some((part) => part.toLowerCase().includes(query));
}

/**
 * Whether the group a session lives in answers to the filter box.
 *
 * People name groups after the thing they hold ("prod", "vault", "lab") and
 * then look for the group, not the machine inside it. Matching the path — the
 * names from the kind root down — keeps that habit working, and keeps a
 * session visible while its group matches.
 */
export function groupPathMatches(path: readonly string[], needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query === "") return false;
  return path.some((name) => name.toLowerCase().includes(query));
}
