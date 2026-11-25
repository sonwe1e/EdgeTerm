import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASKS,
  extractRelativeImports,
  gitChangedFiles,
  parseVerifyArgs,
  planChangedRun,
  resolveAffectedTests,
  summarize,
} from "./verify.mjs";

describe("verify", () => {
  it("runs the repository's gate in the order standards list it", () => {
    expect(DEFAULT_TASKS).toEqual(["format:check", "typecheck", "lint", "test", "test:browser"]);
  });

  it("says ok, FAILED with the code, or skipped (with optional note) for every task", () => {
    const text = summarize([
      { task: "format:check", status: 0, ms: 1500, ran: true },
      { task: "typecheck", status: 2, ms: 800, ran: true },
      { task: "lint", status: 1, ms: 0, ran: false },
      { task: "test", status: 0, ms: 0, ran: false, note: "docs-only" },
      { task: "test:browser", status: 0, ms: 2100, ran: true, note: "2 files" },
    ]);
    expect(text).toContain("format:check   ok 1.5s");
    expect(text).toContain("typecheck      FAILED (2) 0.8s");
    expect(text).toContain("lint           skipped");
    expect(text).toContain("test           skipped (docs-only)");
    expect(text).toContain("test:browser   ok (2 files) 2.1s");
  });

  it("parses --changed, --since and explicit task lists", () => {
    expect(parseVerifyArgs([])).toEqual({ changed: false, since: null, tasks: [] });
    expect(parseVerifyArgs(["format:check", "typecheck"])).toEqual({
      changed: false,
      since: null,
      tasks: ["format:check", "typecheck"],
    });
    expect(parseVerifyArgs(["--changed"])).toEqual({
      changed: true,
      since: null,
      tasks: [],
    });
    expect(parseVerifyArgs(["--since", "HEAD~2", "lint"])).toEqual({
      changed: true,
      since: "HEAD~2",
      tasks: ["lint"],
    });
    expect(parseVerifyArgs(["--since=main"])).toEqual({
      changed: true,
      since: "main",
      tasks: [],
    });
    expect(() => parseVerifyArgs(["--unknown"])).toThrow(/unknown verify option/);
    expect(() => parseVerifyArgs(["--since"])).toThrow(/--since requires/);
  });

  it("classifies empty, docs-only and code edits distinctly", () => {
    expect(planChangedRun([])).toEqual({
      empty: true,
      docsOnly: false,
      codeFiles: [],
    });
    expect(planChangedRun(["docs/team/STATE.md", "README.md", "AGENTS.md"])).toEqual({
      empty: false,
      docsOnly: true,
      codeFiles: [],
    });
    expect(planChangedRun(["src/components/StatusBar.tsx", "docs/notes.md"])).toEqual({
      empty: false,
      docsOnly: false,
      codeFiles: ["src/components/StatusBar.tsx"],
    });
  });

  it("throws when --since names an invalid git ref instead of silently skipping tests", () => {
    expect(() => gitChangedFiles("definitely-not-a-valid-git-ref-000000")).toThrow(
      /invalid --since ref/i,
    );
  });

  it("extracts relative JS/TS and CSS imports while stripping query suffixes", () => {
    const js = `
      import a from "./alpha";
      import "./side.css?raw";
      export { b } from "../beta.ts";
      vi.mock("./gamma", () => ({}));
      const lazy = () => import("./delta");
      import external from "vitest";
    `;
    expect(extractRelativeImports(js, false).sort()).toEqual([
      "../beta.ts",
      "./alpha",
      "./delta",
      "./gamma",
      "./side.css",
    ]);
    expect(extractRelativeImports('@import "./styles/tabs.styles.css";', true)).toEqual([
      "./styles/tabs.styles.css",
    ]);
  });

  it("resolves affected unit and browser tests through the repository import graph", () => {
    const fromVerify = resolveAffectedTests(["scripts/verify.mjs"]);
    expect(fromVerify.unit).toContain("scripts/verify.test.mjs");
    expect(fromVerify.browser).toEqual([]);

    const fromCss = resolveAffectedTests(["src/styles/transfer.styles.css"]);
    expect(fromCss.unit).toContain("src/colourLiterals.test.ts");
    expect(fromCss.unit).toContain("src/components/TransferCenter.rowHeight.test.ts");
    expect(fromCss.browser).toEqual(["src/test/uiAudit.browser.test.ts"]);

    const fromSettingsCss = resolveAffectedTests(["src/styles/settings.styles.css"]);
    expect(fromSettingsCss.unit).toEqual(["src/colourLiterals.test.ts"]);
    expect(fromSettingsCss.browser).toEqual(["src/test/uiAudit.browser.test.ts"]);

    const fromDialog = resolveAffectedTests(["src/components/FontSizeDialog.tsx"]);
    expect(fromDialog.unit).toContain("src/components/FontSizeDialog.test.ts");
  });
});
