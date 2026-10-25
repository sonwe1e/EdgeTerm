import { describe, expect, it } from "vitest";
import {
  findOverclaims,
  lintMessage,
  parseArgs,
  parseMessage,
  parseNameStatus,
  parseNumstat,
  scopeHeuristics,
  summarizeTsc,
} from "./check-commits.mjs";

const rules = (items, level) => items.filter((i) => !level || i.level === level).map((i) => i.rule);

const rows = (n, linesEach, prefix = "src/f") =>
  Array.from({ length: n }, (_, i) => ({
    path: `${prefix}${i}.ts`,
    added: linesEach,
    deleted: 0,
    binary: false,
  }));

describe("parseMessage", () => {
  it("splits subject, body, prefix and Key: fields", () => {
    const m = parseMessage(
      "perf: x\r\n\r\nWhy.\r\nMeasured: baseline 1 / candidate 2\r\nTests: a.test.ts",
    );
    expect(m.prefix).toBe("perf");
    expect(m.subject).toBe("perf: x");
    expect(m.fields.Measured).toBe("baseline 1 / candidate 2");
    expect(m.fields.Tests).toBe("a.test.ts");
  });
});

describe("lintMessage", () => {
  it("accepts a plain feat commit", () => {
    expect(lintMessage({ subject: "feat: add sort", body: "" })).toEqual([]);
  });

  it("rejects unknown, missing and scoped prefixes", () => {
    for (const subject of ["refactor: move code", "move code", "feat(ui): add", "Feat: add"]) {
      expect(rules(lintMessage({ subject }), "ERROR")).toContain("prefix");
    }
  });

  it("rejects subjects longer than 72 characters", () => {
    expect(rules(lintMessage({ subject: "docs: " + "a".repeat(66) }))).not.toContain(
      "subject-length",
    );
    expect(rules(lintMessage({ subject: "docs: " + "a".repeat(67) }), "ERROR")).toContain(
      "subject-length",
    );
  });

  it("requires Measured: or Unmeasured: on perf commits", () => {
    expect(rules(lintMessage({ subject: "perf: stream output" }), "ERROR")).toContain(
      "perf-evidence",
    );
    expect(
      lintMessage({
        subject: "perf: stream output",
        body: "Measured: baseline 40ms / candidate 12ms / Win11 release WebView2",
      }),
    ).toEqual([]);
    expect(
      lintMessage({ subject: "perf: stream output", body: "Unmeasured: no desktop profile yet" }),
    ).toEqual([]);
  });

  it("warns when Measured: lacks baseline/candidate", () => {
    expect(rules(lintMessage({ subject: "perf: x", body: "Measured: faster" }), "WARN")).toContain(
      "perf-evidence",
    );
  });

  it("rejects a quantitative claim on an unmeasured perf commit", () => {
    const items = lintMessage({ subject: "perf: 3x faster output", body: "Unmeasured: later" });
    expect(rules(items, "ERROR")).toContain("perf-evidence");
    expect(
      rules(lintMessage({ subject: "perf: 40% less IPC", body: "Unmeasured: later" }), "ERROR"),
    ).toContain("perf-evidence");
  });

  it("requires a Tests: line on fix commits, and a reason for none", () => {
    expect(rules(lintMessage({ subject: "fix: x" }), "ERROR")).toContain("fix-tests");
    expect(rules(lintMessage({ subject: "fix: x", body: "Tests: none" }), "ERROR")).toContain(
      "fix-tests",
    );
    expect(
      lintMessage({ subject: "fix: x", body: "Tests: none — UI only, verified by hand" }),
    ).toEqual([]);
    expect(
      lintMessage({ subject: "fix: x", body: "Tests: src/a.test.ts fails on 3e6e357" }),
    ).toEqual([]);
  });

  it("warns on overclaim words in the subject only", () => {
    expect(rules(lintMessage({ subject: "feat: add reliable transfers" }), "WARN")).toContain(
      "overclaim",
    );
    expect(rules(lintMessage({ subject: "docs: all good", body: "" }), "WARN")).toContain(
      "overclaim",
    );
    expect(
      rules(lintMessage({ subject: "feat: add transfers", body: "covers all cases" })),
    ).not.toContain("overclaim");
  });

  it("flags review follow-ups for re-review", () => {
    expect(
      rules(lintMessage({ subject: "fix: address review comments", body: "Tests: a" }), "WARN"),
    ).toContain("review-followup");
  });
});

describe("findOverclaims", () => {
  it("matches whole English words and Chinese terms", () => {
    expect(findOverclaims("stop churn from re-rendering the whole app")).toEqual(["whole"]);
    expect(findOverclaims("install wholesale")).toEqual([]);
    expect(findOverclaims("彻底修复卡死")).toEqual(["彻底"]);
  });
});

describe("scopeHeuristics", () => {
  it("warns above the size limits unless Scope: explains it", () => {
    expect(rules(scopeHeuristics({ subject: "feat: x", numstat: rows(2, 750) }))).not.toContain(
      "size",
    );
    expect(rules(scopeHeuristics({ subject: "feat: x", numstat: rows(2, 751) }), "WARN")).toContain(
      "size",
    );
    expect(rules(scopeHeuristics({ subject: "feat: x", numstat: rows(41, 1) }), "WARN")).toContain(
      "size",
    );
    expect(
      rules(
        scopeHeuristics({
          subject: "feat: x",
          body: "Scope: generated protocol table",
          numstat: rows(2, 2000),
        }),
      ),
    ).not.toContain("size");
  });

  it("ignores lock files when counting lines", () => {
    const numstat = [{ path: "package-lock.json", added: 5000, deleted: 0 }, ...rows(1, 10)];
    expect(rules(scopeHeuristics({ subject: "chore: bump", numstat }))).not.toContain("size");
  });

  it("warns when frontend, backend and docs change together", () => {
    const numstat = [
      ...rows(1, 1, "src/a"),
      ...rows(1, 1, "src-tauri/src/b"),
      ...rows(1, 1, "docs/c"),
    ];
    expect(rules(scopeHeuristics({ subject: "feat: x", numstat }), "WARN")).toContain("areas");
    expect(
      rules(scopeHeuristics({ subject: "feat: x", numstat: numstat.slice(0, 2) })),
    ).not.toContain("areas");
  });

  it("warns when a docs commit touches code", () => {
    expect(rules(scopeHeuristics({ subject: "docs: x", numstat: rows(1, 1) }), "WARN")).toContain(
      "docs-with-code",
    );
    expect(
      rules(scopeHeuristics({ subject: "docs: x", numstat: rows(1, 1, "docs/a") })),
    ).not.toContain("docs-with-code");
  });

  it("warns when the body discloses a second concern", () => {
    const c = { subject: "perf: x", body: "Also carries the WebGL toggle.", numstat: [] };
    expect(rules(scopeHeuristics(c), "WARN")).toContain("second-concern");
    expect(rules(scopeHeuristics({ ...c, body: "顺带加入 WebGL 开关" }), "WARN")).toContain(
      "second-concern",
    );
    expect(rules(scopeHeuristics({ ...c, body: "Reduces allocations." }))).not.toContain(
      "second-concern",
    );
  });

  it("hints at --typecheck for deleted sources only when it is not running", () => {
    const c = {
      subject: "feat: x",
      numstat: [],
      nameStatus: [{ status: "D", path: "src/terminalTransfer.ts" }],
    };
    expect(rules(scopeHeuristics(c), "INFO")).toContain("moved-source");
    expect(scopeHeuristics(c, { typecheck: true })).toEqual([]);
  });
});

describe("git output parsers", () => {
  it("parses numstat including binaries and renames", () => {
    expect(
      parseNumstat(
        "3\t1\tsrc/a.ts\n-\t-\ticon.png\n2\t0\tsrc/{old => new}/b.ts\n1\t1\tx.ts => y.ts",
      ),
    ).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1, binary: false },
      { path: "icon.png", added: 0, deleted: 0, binary: true },
      { path: "src/new/b.ts", added: 2, deleted: 0, binary: false },
      { path: "y.ts", added: 1, deleted: 1, binary: false },
    ]);
  });

  it("parses name-status with renames", () => {
    expect(parseNameStatus("D\tsrc/a.ts\nR087\tsrc/b.ts\tsrc/c.ts\nM\tsrc/d.ts")).toEqual([
      { status: "D", path: "src/a.ts" },
      { status: "R", from: "src/b.ts", path: "src/c.ts" },
      { status: "M", path: "src/d.ts" },
    ]);
  });

  it("summarises tsc errors", () => {
    const out =
      "src/a.ts(1,1): error TS2307: Cannot find module './x'.\nnoise\nsrc/b.ts(2,2): error TS7006: any";
    expect(summarizeTsc(out, 1)).toEqual({
      count: 2,
      first: ["src/a.ts(1,1): error TS2307: Cannot find module './x'."],
    });
  });
});

describe("parseArgs", () => {
  it("reads range and flags", () => {
    expect(parseArgs(["a..b", "--typecheck", "--json"])).toMatchObject({
      range: "a..b",
      typecheck: true,
      json: true,
    });
    expect(parseArgs([]).range).toBeNull();
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["abc"])).toThrow(/range/);
    expect(() => parseArgs(["a..b", "c..d"])).toThrow(/unexpected/);
  });
});
