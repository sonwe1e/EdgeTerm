import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeTasks = new Set([
  "doctor",
  "cargo",
  "test:rust",
  "tauri",
  "tauri:dev",
  "tauri:build",
  "bindings",
  "check:bindings",
]);
export function taskCommands(task, args = [], cargo = "cargo") {
  const js = (script, ...flags) => [process.execPath, [path.join(root, script), ...flags, ...args]];
  switch (task) {
    case "dev":
      return [js("node_modules/vite/bin/vite.js")];
    case "preview":
      return [js("node_modules/vite/bin/vite.js", "preview")];
    case "typecheck":
      return [js("node_modules/typescript/bin/tsc", "--noEmit")];
    case "build":
      return [
        [process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]],
        js("node_modules/vite/bin/vite.js", "build"),
      ];
    case "test":
      return [js("node_modules/vitest/vitest.mjs", "run", "--project", "unit")];
    case "test:browser":
      return [js("node_modules/vitest/vitest.mjs", "run", "--project", "browser")];
    case "lint":
      return [js("node_modules/@biomejs/biome/bin/biome", "lint")];
    case "format":
      return [js("node_modules/@biomejs/biome/bin/biome", "format", "--write")];
    case "format:check":
      return [js("node_modules/@biomejs/biome/bin/biome", "format")];
    case "tauri":
      return [js("node_modules/@tauri-apps/cli/tauri.js")];
    case "tauri:dev":
      return [js("node_modules/@tauri-apps/cli/tauri.js", "dev")];
    case "tauri:build":
      return [js("node_modules/@tauri-apps/cli/tauri.js", "build")];
    case "cargo":
      return [[cargo, args]];
    case "test:rust":
      return [
        [cargo, ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", ...args]],
      ];
    case "bindings":
      return [js("scripts/bindings.mjs")];
    case "check:bindings":
      return [js("scripts/bindings.mjs", "--check")];
    case "check:commits":
      return [js("scripts/check-commits.mjs")];
    case "experiment:compiler":
      return [js("scripts/compiler-experiment.mjs")];
    case "script": {
      const [script, ...rest] = args;
      if (
        !script ||
        !/^scripts\/[\w/-]+\.(?:mjs|cjs)$/.test(script) ||
        !existsSync(path.join(root, script))
      ) {
        throw new Error("script requires an existing scripts/<name>.mjs or .cjs path");
      }
      return [[process.execPath, [path.join(root, script), ...rest]]];
    }
    case "doctor":
      return [];
    default:
      throw new Error(
        `Unknown task: ${task}. Use doctor, dev, build, test, test:browser, typecheck, lint, format, format:check, tauri:dev, tauri:build, test:rust, cargo or script.`,
      );
  }
}

export function budgetEnvironment(env) {
  // Bound V8's old-space heap too: two test workers must not each size their
  // heap from all installed RAM. Keep unrelated caller flags intact.
  const existingOptions = (env.NODE_OPTIONS || "").trim();
  const heapLimit = "--max-old-space-size=3072";
  const nodeOptions = existingOptions.endsWith(heapLimit)
    ? existingOptions
    : `${existingOptions} ${heapLimit}`.trim();
  return {
    ...env,
    NODE_OPTIONS: nodeOptions,
    CARGO_BUILD_JOBS: "2",
    RUST_TEST_THREADS: "2",
    CMAKE_BUILD_PARALLEL_LEVEL: "2",
    GOMAXPROCS: "2",
    RAYON_NUM_THREADS: "2",
    UV_THREADPOOL_SIZE: "2",
  };
}

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || "");
    return result.status ?? 1;
  }
  if (capture) process.stdout.write(result.stdout);
  return 0;
}

function doctor(env) {
  console.log(
    JSON.stringify(
      {
        node: process.execPath,
        nodeVersion: process.version,
        npm: path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
        cargo: env.EDGETERM_CARGO || "cargo (PATH)",
        rustc: env.RUSTC || "rustc (PATH)",
        cargoTargetDir: env.CARGO_TARGET_DIR || path.join(root, "src-tauri/target"),
        rustcWrapper: env.RUSTC_WRAPPER,
        rustflags: env.RUSTFLAGS,
        toolchain: env.RUSTUP_TOOLCHAIN,
        msvc: env.VCToolsInstallDir,
        sdk: env.WindowsSdkDir,
        sdkVersion: env.WindowsSDKVersion,
        cpuMask: env.EDGETERM_CPU_MASK,
        allowedLogicalCpus: env.EDGETERM_CPU_COUNT,
        cargoJobs: env.CARGO_BUILD_JOBS,
        rustTestThreads: env.RUST_TEST_THREADS,
        freeMemoryGiB: +(os.freemem() / 1024 ** 3).toFixed(1),
        nodeOptions: env.NODE_OPTIONS,
        nativeTools: env.EDGETERM_NATIVE_TOOLS ? JSON.parse(env.EDGETERM_NATIVE_TOOLS) : undefined,
      },
      null,
      2,
    ),
  );
  for (const command of [env.EDGETERM_CARGO || "cargo", env.RUSTC || "rustc"]) {
    if (run(command, ["--version"], env, true)) return 1;
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const executing = argv[0] === "--execute";
  const request = executing
    ? JSON.parse(process.env.EDGETERM_TASK_REQUEST)
    : { task: argv[0] || "doctor", args: argv.slice(1) };
  taskCommands(request.task, request.args); // Reject bad task names before spawning.
  const env = budgetEnvironment(process.env);
  if (process.platform === "win32" && !executing) {
    // setup-node and other CI installers intentionally configure only this
    // job's PATH. Keep that explicitly provisioned runtime on hosted runners.
    if (env.CI && !env.EDGETERM_NODE) env.EDGETERM_NODE = process.execPath;
    env.EDGETERM_TASK_REQUEST = JSON.stringify({
      ...request,
      native: nativeTasks.has(request.task),
    });
    return run(
      path.join(env.SystemRoot || env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/windows-task.ps1"),
      ],
      env,
    );
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    throw new Error("Use Node.js 20.19+, 22.12+ or 24+ (the installed Vite/Vitest requirements).");
  }
  if (request.task === "doctor") return doctor(env);
  console.log(
    `[edgeterm] ${request.task}: Node ${process.version} (${process.execPath}); jobs=2${env.EDGETERM_CPU_COUNT ? `; CPUs=${env.EDGETERM_CPU_COUNT}, below-normal priority` : ""}`,
  );
  for (const [command, args] of taskCommands(
    request.task,
    request.args,
    env.EDGETERM_CARGO || "cargo",
  )) {
    const status = run(command, args, env);
    if (status) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[edgeterm] ${error.message}`);
    process.exitCode = 1;
  }
}
