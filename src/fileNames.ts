// Whether two names of files on one volume are the same name.
//
// A volume that ignores case (local files on Windows and macOS) treats
// "README.md" and "readme.md" as one file; a remote session, or a POSIX local
// volume, keeps them apart. Every place that decides "does this name already
// exist on the user's disk" has to ask this one question with the same answer:
// a rename or a move that thinks the name is free replaces the file that is
// already there.
//
// This lives in one module because the answer was once written three times — in
// the create box, in the download clash check and in the move check — and the
// move copy compared byte for byte, which silently overwrote a file.
export function sameFileName(candidate: string, name: string, foldCase: boolean): boolean {
  return foldCase ? candidate.toLowerCase() === name.toLowerCase() : candidate === name;
}

/** The names in `candidates` that `present` would replace, in their own order. */
export function namesTaken(
  candidates: readonly string[],
  present: readonly string[],
  foldCase: boolean,
): string[] {
  const fold = (name: string) => (foldCase ? name.toLowerCase() : name);
  const taken = new Set(present.map(fold));
  return candidates.filter((name) => taken.has(fold(name)));
}
