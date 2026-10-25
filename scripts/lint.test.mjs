import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
// Three Biome processes on a cold cache take longer than Vitest's 5s default
// on a loaded machine; the contract is the diagnostics, not the wall clock.
it("rejects unused declarations and missing effect captures with a valid-module control", () => {
  const parent = path.resolve(".tmp");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, "lint-contract-"));
  try {
    mkdirSync(path.join(dir, "src"));
    // Test the rules as a standalone project. The real root force-ignores
    // .tmp, so inherited parent exclusions must not suppress this fixture's
    // intentional direct lint calls.
    const config = JSON.parse(readFileSync("biome.json", "utf8"));
    writeFileSync(path.join(dir, "biome.json"), JSON.stringify({ ...config, root: true }));
    const lint = (input) => {
      writeFileSync(path.join(dir, "src/probe.ts"), input);
      return spawnSync(
        process.execPath,
        [path.resolve("node_modules/@biomejs/biome/bin/biome"), "lint"],
        { cwd: dir, encoding: "utf8" },
      );
    };
    expect(lint("export const value = 1;\n").status).toBe(0);
    const unused = lint("const value = 1;\nexport {};\n");
    expect(unused.status).not.toBe(0);
    expect(unused.stderr).toContain("noUnusedVariables");
    const stale = lint(
      'import {useEffect} from "react"; export function useProbe(value: string) {useEffect(() => { console.log(value); }, []);}\n',
    );
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("useExhaustiveDependencies");
    // Root scans must not discover a leftover fixture's config or diagnostics.
    const fromRoot = spawnSync(
      process.execPath,
      [path.resolve("node_modules/@biomejs/biome/bin/biome"), "lint", dir],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(fromRoot.stderr).not.toContain("nested root configuration");
    // Root scans must not enter interrupted fixtures or historical worktrees.
    expect(fromRoot.stderr).not.toContain("useExhaustiveDependencies");
  } finally {
    if (!dir.startsWith(parent + path.sep)) throw new Error("fixture escaped .tmp");
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
