// Read-only release-version guard: the version that ships in the installer,
// the crate, the lockfiles and the diagnostic reports must be one number.
// The inherited release workflow used to compare package.json with Cargo.toml;
// that job is disabled, so the check lives here and runs in CI.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const packageJson = JSON.parse(read("../package.json"));
const packageLock = JSON.parse(read("../package-lock.json"));
const tauriConfig = JSON.parse(read("../src-tauri/tauri.conf.json"));
const cargoManifest = read("../src-tauri/Cargo.toml");
const cargoLock = read("../src-tauri/Cargo.lock");

const version = packageJson.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json has no usable version: ${String(version)}`);
  process.exit(1);
}

const failures = [];
const same = (label, actual) => {
  if (actual !== version) {
    failures.push(`${label} is ${String(actual)}, package.json says ${version}`);
  }
};

same("package-lock.json version", packageLock.version);
same('package-lock.json packages[""].version', packageLock.packages?.[""]?.version);

const cargoVersion = cargoManifest.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
same("src-tauri/Cargo.toml [package] version", cargoVersion);

// Only the workspace member, not an unrelated crate that happens to share the
// number (Cargo.lock also carries third-party versions).
const locked = [
  ...cargoLock.matchAll(/\[\[package\]\]\r?\nname = "edgeterm"\r?\nversion = "([^"]+)"/g),
].map((match) => match[1]);
if (locked.length !== 1) {
  failures.push(`src-tauri/Cargo.lock: expected one edgeterm package, found ${locked.length}`);
}
for (const lockedVersion of locked) same("src-tauri/Cargo.lock edgeterm version", lockedVersion);

// The desktop bundle derives its version from package.json; pinning a literal
// here would silently stop following version:set.
if (tauriConfig.version !== "../package.json") {
  failures.push(
    `src-tauri/tauri.conf.json version is ${String(tauriConfig.version)}; expected "../package.json"`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`version mismatch: ${failure}`);
  process.exit(1);
}
console.log(`versions agree: ${version} (package.json, package-lock.json, Cargo.toml, Cargo.lock)`);
