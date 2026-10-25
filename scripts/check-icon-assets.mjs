// Post-build guard for the file icon assets: every icon the theme JSON can
// name must exist as a real file in dist, not just as a path string. Run
// after `vite build` (npm run check:icons):
//
//   node scripts/check-icon-assets.mjs [--dist <dir>]
//
// Checks, in order:
// 1. The built fileIcons chunk carries one theme-package source key per
//    non-open SVG (the map the resolver reads; the minifier may hoist URL
//    values into variables, so keys and values are checked separately).
// 2. Every /assets/*.svg URL the chunk mentions resolves to a file on disk
//    under dist - a broken or pruned asset fails here.
// 3. Every icon name the theme JSON references (file/folder defaults,
//    fileNames, fileExtensions, folderNames and their light overrides, minus
//    the `.clone` suffix) is present among the chunk's map keys - a miss
//    would make the UI silently fall back to the default icon.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

const dist = arg("--dist", join(process.cwd(), "dist"));
const assets = join(dist, "assets");

const chunkFiles = (await readdir(assets)).filter((name) => /^fileIcons.*\.js$/.test(name));
if (chunkFiles.length !== 1) {
  console.error(`expected exactly one fileIcons chunk in ${assets}, found ${chunkFiles.length}`);
  process.exit(1);
}
const code = await readFile(join(assets, chunkFiles[0]), "utf8");

const sources = (
  await readdir(join(process.cwd(), "node_modules/material-icon-theme/icons"))
).filter((name) => name.endsWith(".svg") && !name.endsWith("-open.svg"));

const strip = (name) => name.replace(/\.clone$/, "");
const failures = [];

// 1. The map's source keys: the glob inlines one object entry per SVG.
const keys = new Set();
for (const [, path] of code.matchAll(
  /"(\/node_modules\/material-icon-theme\/icons\/[^"]+\.svg)":/g,
)) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  keys.add(base.replace(/\.svg$/, "").replace(/\.clone$/, ""));
}
if (keys.size !== sources.length) {
  failures.push(`chunk map has ${keys.size} keys, the package has ${sources.length} non-open SVGs`);
}

// 2. Every asset URL the chunk mentions is a real file in dist.
const urls = [...code.matchAll(/"(\/assets\/[^"]+\.svg)"/g)].map((m) => m[1]);
if (urls.length === 0) {
  failures.push("the chunk mentions no /assets/*.svg URL at all");
}
let missing = 0;
for (const url of new Set(urls)) {
  try {
    await readFile(join(dist, url.slice(1)));
  } catch {
    missing += 1;
    if (missing <= 5) failures.push(`missing asset file: ${url}`);
  }
}
if (missing > 5) failures.push(`... and ${missing - 5} more missing asset files`);

// 3. The theme's referenced icons all resolve through the map.
const theme = JSON.parse(
  await readFile(
    join(process.cwd(), "node_modules/material-icon-theme/dist/material-icons.json"),
    "utf8",
  ),
);
const referenced = new Set(
  [
    theme.file,
    theme.folder,
    theme.light?.file,
    theme.light?.folder,
    ...Object.values(theme.fileNames ?? {}),
    ...Object.values(theme.fileExtensions ?? {}),
    ...Object.values(theme.folderNames ?? {}),
    ...Object.values(theme.light?.fileNames ?? {}),
    ...Object.values(theme.light?.fileExtensions ?? {}),
    ...Object.values(theme.light?.folderNames ?? {}),
  ]
    .filter((name) => typeof name === "string")
    .map(strip),
);
const unresolved = [...referenced].filter((icon) => !keys.has(icon));
for (const icon of unresolved) {
  failures.push(`theme references icon "${icon}" that the chunk map does not carry`);
}

if (failures.length > 0) {
  console.error(`icon asset check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `icon assets ok: ${keys.size} map keys, ${urls.length} asset URL mentions, ` +
    `${referenced.size} referenced icons, every URL present under ${dist}`,
);
