import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
it("rejects unused declarations and missing effect captures with a valid-module control", () => {
  const parent = path.resolve(".tmp");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, "lint-contract-"));
  try {
    mkdirSync(path.join(dir, "src"));
    copyFileSync("biome.json", path.join(dir, "biome.json"));
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
  } finally {
    if (!dir.startsWith(parent + path.sep)) throw new Error("fixture escaped .tmp");
    rmSync(dir, { recursive: true, force: true });
  }
});
