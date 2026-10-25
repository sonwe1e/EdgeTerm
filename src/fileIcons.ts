// File and folder icons from the VS Code "Material Icon Theme" (PKief), resolved
// the way VS Code resolves a file icon theme: exact file name first, then the
// longest matching extension, then the theme's default file / folder icon.
import {
  file as defaultFileIcon,
  fileExtensions,
  fileNames,
  folder as defaultFolderIcon,
  folderNames,
  light,
} from "material-icon-theme/dist/material-icons.json";

import { isLightTheme, type ThemeMode } from "./types";

// One SVG asset per icon (`?no-inline` keeps Vite from inlining the small
// ones as data URLs): a row's <img> reads the SVG it needs straight from the
// app's own origin, the browser caches each SVG separately, and this lazy
// module stays a name-to-URL map instead of ~850 KB of SVG markup that the
// first Filer open parses and keeps on the heap (ESM caches the module, so
// later opens pay neither the parse nor the markup). The `.clone` suffix
// marks generated colour variants, not part of the name. The Filer is a flat
// list, so expanded "-open" folders are never shown.
const iconUrl: Record<string, string> = {};
for (const [path, url] of Object.entries(
  import.meta.glob(
    [
      "/node_modules/material-icon-theme/icons/*.svg",
      "!/node_modules/material-icon-theme/icons/*-open.svg",
    ],
    { eager: true, query: "?no-inline", import: "default" },
  ) as Record<string, string>,
)) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  iconUrl[base.replace(/\.svg$/, "").replace(/\.clone$/, "")] = url;
}

// VS Code matches names case-insensitively, so lower-case the mapping keys
// once instead of on every lookup.
function lowerKeys(map: Record<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) {
    result.set(key.toLowerCase(), value);
  }
  return result;
}

interface IconMaps {
  fileNames: Map<string, string>;
  fileExtensions: Map<string, string>;
  folderNames: Map<string, string>;
}

const darkMaps: IconMaps = {
  fileNames: lowerKeys(fileNames),
  fileExtensions: lowerKeys(fileExtensions),
  folderNames: lowerKeys(folderNames),
};

const lightMaps: IconMaps = {
  fileNames: lowerKeys(light.fileNames),
  fileExtensions: lowerKeys(light.fileExtensions),
  folderNames: lowerKeys(light.folderNames),
};

function lookupFile(maps: IconMaps, name: string): string | undefined {
  const exact = maps.fileNames.get(name);
  if (exact) return exact;
  // "archive.tar.gz" tries "tar.gz" before "gz", matching VS Code's preference
  // for the most specific extension.
  const segments = name.split(".");
  for (let index = 1; index < segments.length; index++) {
    const icon = maps.fileExtensions.get(segments.slice(index).join("."));
    if (icon) return icon;
  }
  return undefined;
}

function resolveIconName(name: string, isDir: boolean, theme: ThemeMode): string {
  const lower = name.toLowerCase();
  if (isDir) {
    return (
      (isLightTheme(theme) ? lightMaps.folderNames.get(lower) : undefined) ??
      darkMaps.folderNames.get(lower) ??
      defaultFolderIcon
    );
  }
  return (
    (isLightTheme(theme) ? lookupFile(lightMaps, lower) : undefined) ??
    lookupFile(darkMaps, lower) ??
    defaultFileIcon
  );
}

/** URL of the Material icon for a file or folder entry. */
export function fileIconSource(name: string, isDir: boolean, theme: ThemeMode): string {
  const icon = resolveIconName(name, isDir, theme);
  // An icon name the asset glob does not carry falls back to the theme's
  // default, exactly like the built-in maps do.
  const key = iconUrl[icon] ? icon : isDir ? defaultFolderIcon : defaultFileIcon;
  return iconUrl[key];
}
