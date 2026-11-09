import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ spawnSync: vi.fn(), rewrite: null, target: null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: harness.spawnSync,
    default: { ...(actual.default ?? actual), spawnSync: harness.spawnSync },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = (file, ...args) => {
    const value = actual.readFileSync(file, ...args);
    return harness.rewrite ? harness.rewrite(file, value) : value;
  };
  return {
    ...actual,
    readFileSync,
    default: { ...(actual.default ?? actual), readFileSync },
  };
});

const originalArgv = process.argv;
const checkedIn = readFileSync("src/bindings.ts", "utf8");

beforeEach(() => {
  vi.resetModules();
  harness.spawnSync.mockReset();
  harness.rewrite = null;
  harness.target = null;
  process.argv = [process.execPath, "scripts/bindings.mjs", "--check"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  harness.rewrite = null;
  if (harness.target) expect(existsSync(path.dirname(harness.target))).toBe(false);
  expect(readFileSync("src/bindings.ts", "utf8")).toBe(checkedIn);
  vi.restoreAllMocks();
});

// Exercise the actual preflight/comparison script without invoking Cargo.
// Mocked exporter output proves the gate, not freshness of Rust-generated types.
function exporter(content = checkedIn, diff = { status: 1, stdout: "", stderr: "" }) {
  harness.spawnSync.mockImplementation((command, _args, options) => {
    if (command === "git") return diff;
    harness.target = options.env.EDGETERM_BINDINGS_OUT;
    writeFileSync(harness.target, content);
    return { status: 0, stdout: "", stderr: "" };
  });
}

describe("Rust binding verification entry", () => {
  it("classifies the registered raw image IPC and still invokes the exporter", async () => {
    exporter(checkedIn.replaceAll("\n", " \r\n"));
    await import("./bindings.mjs");
    expect(harness.spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = harness.spawnSync.mock.calls[0];
    expect(command).toBe(process.env.EDGETERM_CARGO || "cargo");
    expect(args).toEqual([
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--features",
      "bindings",
      "--lib",
      "bindings::export_bindings",
      "--",
      "--exact",
    ]);
    expect(options.env.EDGETERM_BINDINGS_OUT).toBe(harness.target);
    expect(harness.target).not.toBe(path.resolve("src/bindings.ts"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("6 explicit exceptions"));
  });

  it("rejects an unclassified registration before invoking Cargo", async () => {
    harness.rewrite = (file, value) =>
      file === "src-tauri/src/lib.rs"
        ? value.replace("commands::preview_image_file,", "commands::unclassified_command,")
        : value;
    await expect(import("./bindings.mjs")).rejects.toThrow(
      "Unclassified commands: unclassified_command",
    );
    expect(harness.spawnSync).not.toHaveBeenCalled();
  });

  it("rejects an obsolete raw exception before invoking Cargo", async () => {
    harness.rewrite = (file, value) =>
      file === "src-tauri/src/lib.rs" ? value.replace("commands::preview_image_file,", "") : value;
    await expect(import("./bindings.mjs")).rejects.toThrow("Manual exception inventory is stale");
    expect(harness.spawnSync).not.toHaveBeenCalled();
  });

  it("keeps Rust exporter failures fatal instead of comparing a stale file", async () => {
    harness.spawnSync.mockReturnValue({ status: 101, stdout: "fixture failure", stderr: "" });
    await expect(import("./bindings.mjs")).rejects.toThrow("Rust export failed (101)");
    expect(harness.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("reports a bounded known-file diff and leaves stale bindings as a failure", async () => {
    exporter(`${checkedIn}\n// changed generated contract\n`, {
      status: 1,
      stdout: `diff --git a/src/bindings.ts b/generated/bindings.ts\n${"x".repeat(20_000)}`,
      stderr: "PRIVATE_DIAGNOSTIC_MUST_NOT_BE_LOGGED",
    });
    const error = await import("./bindings.mjs").catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Stale src/bindings.ts");
    expect(error.message).toContain("diff --git a/src/bindings.ts");
    expect(error.message).toContain("diff truncated after 12000 characters");
    expect(error.message.length).toBeLessThan(13_000);
    expect(error.message).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(harness.spawnSync).toHaveBeenLastCalledWith(
      "git",
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        "src/bindings.ts",
        harness.target,
      ],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 256 * 1024 }),
    );
  });

  it("still rejects stale bindings when a diagnostic diff is unavailable", async () => {
    exporter(`${checkedIn}\n// changed generated contract\n`, {
      status: null,
      error: new Error("fixture git unavailable"),
      stdout: "",
      stderr: "PRIVATE_DIAGNOSTIC_MUST_NOT_BE_LOGGED",
    });
    await expect(import("./bindings.mjs")).rejects.toThrow(
      "Stale src/bindings.ts: run npm run bindings and review the wire contract diff\n[bounded generated-file diff unavailable]",
    );
  });
});
