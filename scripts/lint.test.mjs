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
    // `root: false` keeps this a child config. If cleanup is ever interrupted,
    // a verbatim copy would sit in .tmp as a second root config and make
    // `npm run lint` fail from the repository root forever.
    const config = JSON.parse(readFileSync("biome.json", "utf8"));
    writeFileSync(path.join(dir, "biome.json"), JSON.stringify({ ...config, root: false }));
    const lint = (input) => {
      writeFileSync(path.join(dir, "src/probe.ts"), input);
      return spawnSync(process.execPath, [path.resolve("node_modules/@biomejs/biome/bin/biome"), "lint"], { cwd: dir, encoding: "utf8" });
    };
    expect(lint("export const value = 1;\n").status).toBe(0);
    const unused = lint("const value = 1;\nexport {};\n");
    expect(unused.status).not.toBe(0);
    expect(unused.stderr).toContain("noUnusedVariables");
    const stale = lint('import {useEffect} from "react"; export function useProbe(value: string) {useEffect(() => { console.log(value); }, []);}\n');
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("useExhaustiveDependencies");
    // A leftover fixture must stay lintable from the repository root. With a
    // verbatim config copy Biome reports "nested root configuration" here,
    // which would break `npm run lint` for every later run.
    const fromRoot = spawnSync(
      process.execPath,
      [path.resolve("node_modules/@biomejs/biome/bin/biome"), "lint", dir],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(fromRoot.stderr).not.toContain("nested root configuration");
  } finally {
    if (!dir.startsWith(parent + path.sep)) throw new Error("fixture escaped .tmp");
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
