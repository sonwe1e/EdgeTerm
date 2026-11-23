import { describe, expect, it } from "vitest";

import { MAX_SNIPPETS } from "./snippets";
import { exportSnippets, importSnippets } from "./snippetTransfer";

const snippet = (id: string, name: string, command: string) => ({ id, name, command });

describe("saved-command bundles", () => {
  it("exports names and commands without local ids", () => {
    const text = exportSnippets([snippet("a", "Logs", "tail -f app.log")]);
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ format: "edgeterm-snippets", version: 1 });
    expect(parsed.snippets).toEqual([{ name: "Logs", command: "tail -f app.log" }]);
    expect(text).not.toContain('"id"');
  });

  it("round-trips a list", () => {
    const source = [snippet("a", "Logs", "tail -f app.log"), snippet("b", "Deploy", "deploy prod")];
    const result = importSnippets(exportSnippets(source));
    expect(result).toEqual({
      ok: true,
      entries: [
        { name: "Logs", command: "tail -f app.log" },
        { name: "Deploy", command: "deploy prod" },
      ],
      skipped: 0,
    });
  });

  it("names why a bundle was refused", () => {
    expect(importSnippets("not json")).toEqual({ ok: false, reason: "not-json" });
    expect(importSnippets("[]")).toEqual({ ok: false, reason: "wrong-format" });
    expect(importSnippets('{"format":"something-else","snippets":[]}')).toEqual({
      ok: false,
      reason: "wrong-format",
    });
    expect(importSnippets('{"format":"edgeterm-snippets","snippets":[]}')).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      importSnippets('{"format":"edgeterm-snippets","snippets":[{"name":"  ","command":"ls"}]}'),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("skips unusable entries, counts them, and keeps the last of a repeated name", () => {
    const text = JSON.stringify({
      format: "edgeterm-snippets",
      version: 1,
      snippets: [
        { name: "Logs", command: "tail app.log" },
        { name: "Broken" },
        { name: "Logs", command: "tail -f app.log" },
        { name: "Empty", command: "   " },
      ],
    });
    expect(importSnippets(text)).toEqual({
      ok: true,
      entries: [{ name: "Logs", command: "tail -f app.log" }],
      skipped: 2,
    });
  });

  it("stops at the list cap", () => {
    const many = Array.from({ length: MAX_SNIPPETS + 5 }, (_, index) => ({
      name: "cmd " + index,
      command: "echo " + index,
    }));
    const result = importSnippets(
      JSON.stringify({ format: "edgeterm-snippets", version: 1, snippets: many }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(MAX_SNIPPETS);
  });

  it("cleans names the way the store does", () => {
    const text = JSON.stringify({
      format: "edgeterm-snippets",
      snippets: [{ name: "  Logs\u0007  ", command: "tail app.log" }],
    });
    expect(importSnippets(text)).toEqual({
      ok: true,
      entries: [{ name: "Logs", command: "tail app.log" }],
      skipped: 0,
    });
  });
});
