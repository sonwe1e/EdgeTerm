export interface TreeFile {
  name: string;
  path: string;
}

export interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: TreeFile[];
}

/**
 * Builds a directory tree from the flat relative paths a project listing
 * returns. Files are sorted after directories, both by name, and an empty
 * directory is dropped: the listing only knows files.
 */
export function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  const directories = new Map<string, TreeDir>([["", root]]);
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || path.endsWith("/")) continue;
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const full = parts.join("/");
    if (seen.has(full)) continue;
    seen.add(full);
    let parent = root;
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let child = directories.get(prefix);
      if (!child) {
        child = { name: part, path: prefix, dirs: [], files: [] };
        directories.set(prefix, child);
        parent.dirs.push(child);
      }
      parent = child;
    }
    const name = parts[parts.length - 1];
    parent.files.push({ name, path: full });
  }
  sortDir(root);
  return root;
}

function sortDir(dir: TreeDir): void {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of dir.dirs) sortDir(child);
}

/** Every directory path in the tree, for "expand all". */
export function directoryPaths(dir: TreeDir): string[] {
  const paths: string[] = [];
  for (const child of dir.dirs) {
    paths.push(child.path, ...directoryPaths(child));
  }
  return paths;
}
