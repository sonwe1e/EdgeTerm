// Builds the release attachments from a finished Tauri build: the NSIS
// installer is copied, the portable zip and the diagnostics zip are assembled,
// and SHA256SUMS.txt lists all three. Pure Node, so a release no longer depends
// on hand-assembling them; the same command checks a downloaded set.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const outDir = path.join(root, "artifacts", `release-${version}`);
const exePath = path.join(root, "src-tauri", "target", "release", "edgeterm.exe");
const installerPath = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `EdgeTerm_${version}_x64-setup.exe`,
);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// --- a minimal deterministic zip -------------------------------------------
// Tauri's own bundles are built by its tools; these two archives are ours, and
// a fixed entry timestamp keeps their bytes — and so their checksums —
// identical between two runs on the same inputs.
const ZIP_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * One zip member. Everything is deflated: the executable halves in size, which
 * is what the published portable archives carried, and directories stay empty.
 */
export function zipEntry(name, content, { directory = false } = {}) {
  const data = directory ? Buffer.alloc(0) : content;
  return {
    name: Buffer.from(name, "utf8"),
    data,
    body: directory ? data : zlib.deflateRawSync(data, { level: 9 }),
    method: directory ? 0 : 8,
    crc: crc32(data),
    external: directory ? 0o40755 << 16 : 0o644 << 16,
  };
}

export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(ZIP_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, entry.name, entry.body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(ZIP_DATE, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(entry.external, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, entry.name);

    offset += header.length + entry.name.length + entry.body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(local), directory, end]);
}

// --- the three attachments --------------------------------------------------
const portableReadme = (appVersion) => `EdgeTerm ${appVersion} portable (Windows x64)

Run EdgeTerm.exe directly; nothing is installed. Session profiles and settings live in
the data folder next to the executable, so the whole folder can move between
machines or live on a removable drive.

If the data folder is missing after extraction, create it: an empty data
folder beside EdgeTerm.exe is what enables portable mode. Without it the app
stores configuration under %APPDATA% like an installed copy.

Notes:
- Requires the Microsoft Edge WebView2 runtime, preinstalled on current
  Windows 10 and 11.
- Passwords and passphrases are kept in memory for the current run only in
  portable mode. Enter them again after restarting; profiles and settings travel.
- Updates are not installed in place: when a new version is available,
  download the new portable zip from the release page and replace the program
  files. Preserve your existing data folder; do not overwrite it with the empty
  folder in the new archive.
`;

const diagnosticsReadme = (appVersion) => `EdgeTerm ${appVersion} Windows diagnostics

diagnose-hang.cmd runs diagnose-hang.ps1 against a running EdgeTerm.exe and
writes a JSON report to Desktop/EdgeTerm-diagnostics. It is read-only: it does
not restart, terminate or screenshot the app, does not read terminal content
and does not upload anything.

Run it from a normal PowerShell or cmd window when the window stops responding:

    diagnose-hang.cmd

Full guide: docs/sidebar-freeze-diagnostics.zh-CN.md in the source repository.
`;

/** The portable archive: the same executable with an empty data folder. */
export function portableArchive(appVersion, exe, readme = portableReadme(appVersion)) {
  return {
    name: `EdgeTerm_${appVersion}_x64-portable.zip`,
    buffer: buildZip([
      zipEntry("EdgeTerm.exe", exe),
      zipEntry("README.txt", Buffer.from(readme, "utf8")),
      zipEntry("data/", Buffer.alloc(0), { directory: true }),
    ]),
  };
}

export function diagnosticsArchive(appVersion, scripts, readme = diagnosticsReadme(appVersion)) {
  return {
    name: `EdgeTerm_${appVersion}_windows-diagnostics.zip`,
    buffer: buildZip([
      ...scripts.map(([name, content]) => zipEntry(name, content)),
      zipEntry("README.txt", Buffer.from(readme, "utf8")),
    ]),
  };
}

function readOptional(file, what) {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`missing ${what}: ${path.relative(root, file)}`);
  }
}

// --- modes ------------------------------------------------------------------
export function check(dir = outDir) {
  const sums = path.join(dir, "SHA256SUMS.txt");
  const expected = new Map(
    readFileSync(sums, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name, hash];
      }),
  );
  const failures = [];
  for (const [name, hash] of expected) {
    let actual;
    try {
      actual = sha256(readFileSync(path.join(dir, name)));
    } catch {
      failures.push(`${name}: missing`);
      continue;
    }
    if (actual !== hash) failures.push(`${name}: ${actual} != ${hash}`);
    else console.log(`ok   ${name} ${actual}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`mismatch: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${expected.size} attachments match ${path.relative(root, sums)}`);
}

export function packageAll() {
  const exe = readOptional(exePath, "release build");
  let installer;
  try {
    installer = readFileSync(installerPath);
  } catch {
    throw new Error(
      `${path.relative(root, installerPath)} is missing; run ./dev.ps1 tauri:build --bundles nsis first`,
    );
  }
  // A bundle left from an earlier build would ship an executable that does not
  // match this source tree. The bundler patches the binary and immediately runs
  // makensis over it, so the two timestamps land in the same second; only a
  // clearly older installer means a stale bundle.
  const installerTime = statSync(installerPath).mtimeMs;
  const exeTime = statSync(exePath).mtimeMs;
  if (installerTime + 5000 < exeTime) {
    throw new Error(
      `the NSIS installer (${new Date(installerTime).toISOString()}) is older than target/release/edgeterm.exe (${new Date(exeTime).toISOString()}); rebuild with ./dev.ps1 tauri:build --bundles nsis`,
    );
  }

  const files = [
    { name: path.basename(installerPath), buffer: installer },
    portableArchive(version, exe),
    diagnosticsArchive(version, [
      [
        "diagnose-hang.ps1",
        readOptional(path.join(root, "scripts", "diagnose-hang.ps1"), "diagnostic"),
      ],
      [
        "diagnose-hang.cmd",
        readOptional(path.join(root, "scripts", "diagnose-hang.cmd"), "diagnostic"),
      ],
    ]),
  ];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const file of files) writeFileSync(path.join(outDir, file.name), file.buffer);
  writeFileSync(
    path.join(outDir, "SHA256SUMS.txt"),
    `${files
      .map((file) => `${sha256(file.buffer)}  ${file.name}`)
      .sort()
      .join("\n")}\n`,
  );

  for (const file of files) {
    console.log(`${file.name}\t${file.buffer.length.toLocaleString("en-US")} bytes`);
  }
  console.log(`written to ${path.relative(root, outDir)}`);
}

function main(argv) {
  try {
    if (argv[0] === "--check") check(argv[1] === undefined ? outDir : path.resolve(root, argv[1]));
    else packageAll();
  } catch (error) {
    console.error(`package-release: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
