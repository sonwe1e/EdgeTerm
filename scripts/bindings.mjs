// Offline Rust-source contract export. No app startup, user store or connections.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = process.cwd();
const check = process.argv.slice(2).includes("--check");
const parent = path.resolve(".tmp");
mkdirSync(parent, { recursive: true });
const temporary = mkdtempSync(path.join(parent, "bindings-"));
try {
  const registered = readFileSync("src-tauri/src/lib.rs", "utf8").split(".invoke_handler(tauri::generate_handler![")[1].split("])")[0].match(/(?:commands::)?\b[a-z][a-z_]+\b/g).map(x => x.replace("commands::", ""));
  const exported = [...readFileSync("src-tauri/src/bindings.rs", "utf8").matchAll(/(?:commands::|crate::)([a-z][a-z_]+),?/g)].map(m => m[1]).filter(n => registered.includes(n));
  const manual = ["open_session", "write_session_bytes", "zmodem_read_bytes", "zmodem_write_bytes", "open_local_path"];
  const missing = registered.filter(n => !exported.includes(n) && !manual.includes(n));
  if (missing.length) throw new Error(`Unclassified commands: ${missing.join(", ")}`);
  if (manual.some(n => !registered.includes(n))) throw new Error("Manual exception inventory is stale");
  const target = check ? path.join(temporary, "bindings.ts") : path.resolve("src/bindings.ts");
  const run = spawnSync(process.env.EDGETERM_CARGO || "cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "bindings", "--lib", "bindings::export_bindings", "--", "--exact"], {
    cwd: root, env: { ...process.env, RUST_MIN_STACK: "16777216", EDGETERM_BINDINGS_OUT: target },
    // A cold, resource-bounded Rust build legitimately takes over 3 minutes.
    // Let the managed task own its lifetime instead of timing out only Cargo
    // and leaving its compiler children behind.
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`Rust export failed (${run.status}): ${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
  // Specta's multi-line unions end lines with a space. Strip it so the
  // generated file passes `git diff --check`; the contract is unchanged.
  const normalize = (text) =>
    text.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
  if (!check) writeFileSync(target, normalize(readFileSync(target, "utf8")));
  if (check && normalize(readFileSync(target, "utf8")) !== normalize(readFileSync("src/bindings.ts", "utf8"))) throw new Error("Stale src/bindings.ts: run npm run bindings and review the wire contract diff");
  console.log(`${check ? "Fresh" : "Generated"} Rust bindings: ${exported.length}/${registered.length} commands, 5 events; ${manual.length} explicit exceptions.`);
} finally {
  if (!temporary.startsWith(parent + path.sep)) throw new Error("temporary output escaped .tmp");
  rmSync(temporary, { recursive: true, force: true });
}
