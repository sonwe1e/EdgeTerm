/**
 * The command that walks the shell of a file panel's own session to the folder
 * on screen — the inverse of "reveal the terminal's folder here".
 *
 * The family is read off the path, not the platform: the Filer browses remote
 * POSIX paths over SFTP on every platform, and local paths are Windows ones
 * when they start with a drive letter or a backslash. Quoting differs, because
 * a single quote ends a POSIX single-quoted string (it is written as '\''
 * there) while PowerShell escapes it by doubling it.
 */
export function cdCommand(path: string): string | null {
  const target = path.trim();
  if (target === "") return null;
  if (target.startsWith("/")) return `cd '${target.split("'").join("'\\''")}'`;
  return `cd '${target.split("'").join("''")}'`;
}
