import { describe, expect, it } from "vitest";

import {
  SEMANTIC_BANDS,
  SEMANTIC_COLORS,
  SEMANTIC_PALETTES,
  isShellPrompt,
  semanticLine,
  setSemanticColorTheme,
  shellPromptEnd,
} from "./semanticColors";

/**
 * The highlighter reads terminal output and answers ranges; it decides how
 * familiar shell output looks. These tests pin the prompt vocabulary shared
 * with command tracking, and the invariants every answer must keep — sorted,
 * in bounds, non-empty colors — before any single color.
 */

const prompt = (text: string) => text.slice(0, shellPromptEnd(text));

const colorsOf = (text: string) => semanticLine(text).ranges.map((range) => range.color);

describe("shell prompt vocabulary", () => {
  it("ends a user@host prompt at the sign", () => {
    expect(prompt("user@host:~$ ls -la")).toBe("user@host:~$");
    expect(prompt("root@box:/srv# systemctl status")).toBe("root@box:/srv#");
  });

  it("accepts a bracketed and a prefixed prompt", () => {
    expect(prompt("[deploy@web1 ~]$ make")).toBe("[deploy@web1 ~]$");
    expect(prompt("(venv) deploy@web1:/app$ pytest")).toBe("(venv) deploy@web1:/app$");
  });

  it("reads cmd.exe and PowerShell prompts", () => {
    expect(prompt("C:\\Users\\me>dir")).toBe("C:\\Users\\me>");
    expect(prompt("PS C:\\Users\\me> ls")).toBe("PS C:\\Users\\me>");
    expect(prompt("PS> ls")).toBe("PS>");
  });

  it("reads bare and continuation prompts", () => {
    expect(prompt("❯ git status")).toBe("❯");
    expect(prompt(">>> 1 + 1")).toBe(">>>");
    expect(prompt("$ ls")).toBe("$");
  });

  it("refuses text that is not a prompt", () => {
    expect(shellPromptEnd("hello world")).toBe(-1);
    expect(shellPromptEnd("# a comment, not root")).toBe(-1);
    expect(shellPromptEnd("https://example.com/x>")).toBe(-1);
  });

  it("calls a prompt alone a prompt, and a prompt with a command not one", () => {
    expect(isShellPrompt("user@host:~$")).toBe(true);
    expect(isShellPrompt("user@host:~$ ")).toBe(true);
    expect(isShellPrompt("user@host:~$ ls")).toBe(false);
    expect(isShellPrompt("no prompt here")).toBe(false);
  });
});

describe("semantic ranges", () => {
  const cases = [
    "error: could not connect to host 10.0.0.4:22",
    "-rwxr-xr-x 1 deploy deploy 4096 Nov 23 12:00 app.log",
    "+ added a line",
    "- removed a line",
    "see https://example.com/path?q=1 for details",
    "deploy@web1:~$ echo hi",
    "NAME        STATUS   AGE",
    "",
  ];

  it("keeps every answer sorted, in bounds and colored", () => {
    for (const text of cases) {
      const line = semanticLine(text);
      let previousEnd = 0;
      for (const range of line.ranges) {
        expect(range.start, text).toBeGreaterThanOrEqual(previousEnd);
        expect(range.end, text).toBeGreaterThan(range.start);
        expect(range.end, text).toBeLessThanOrEqual(text.length);
        expect(range.color, text).toMatch(/^#[0-9a-f]{6}$/i);
        previousEnd = range.end;
      }
      expect(line.ranges.length, text).toBeLessThanOrEqual(240);
    }
  });

  it("paints nothing for an empty line", () => {
    expect(semanticLine("")).toEqual({ ranges: [] });
  });

  it("gives an error line a red range and the error band", () => {
    const line = semanticLine("error: could not connect");
    expect(line.ranges.some((range) => range.color === SEMANTIC_COLORS.red)).toBe(true);
    expect(line.band).toBe(SEMANTIC_BANDS.dark.error);
  });

  it("underlines a URL in sky", () => {
    const line = semanticLine("see https://example.com/path for details");
    const link = line.ranges.find((range) => range.underline === true);
    expect(link).toBeDefined();
    expect(link!.color).toBe(SEMANTIC_COLORS.sky);
  });

  it("colors an ls permission string bit by bit", () => {
    const text = "-rwxr-xr-x 1 deploy deploy 0 Nov 23 12:00 app.log";
    const colors = colorsOf(text);
    expect(colors).toContain(SEMANTIC_COLORS.sky);
    expect(colors).toContain(SEMANTIC_COLORS.amber);
    expect(colors).toContain(SEMANTIC_COLORS.red);
  });

  it("bands additions and removals like a diff", () => {
    expect(semanticLine("+ added a line").band).toBe(SEMANTIC_BANDS.dark.added);
    expect(semanticLine("-removed a line").band).toBe(SEMANTIC_BANDS.dark.removed);
  });

  it("never mistakes a YAML or Markdown list item for a removal", () => {
    // One dash and one space is a list, not a diff: tinting it red would turn
    // every config file the reader cats into a warning.
    expect(semanticLine("- a list item").band).toBeUndefined();
    expect(
      semanticLine("- a list item").ranges.some((range) => range.color === SEMANTIC_COLORS.red),
    ).toBe(false);
  });

  it("tints a table header row", () => {
    expect(semanticLine("NAME   STATUS   AGE").band).toBe(SEMANTIC_BANDS.dark.header);
  });

  it("leaves a comment grey and unbanded", () => {
    const line = semanticLine("# a note to self");
    expect(line.band).toBeUndefined();
    expect(line.ranges[0]?.color).toBe(SEMANTIC_COLORS.gray);
  });

  it("colors a PowerShell mode column by its letters", () => {
    const colors = colorsOf("d----- 2026-11-23 12:00 folder");
    expect(colors).toContain(SEMANTIC_COLORS.purple);
  });

  it("keeps its invariants under the serialX themes too", () => {
    try {
      for (const mode of ["serialx-dark", "serialx-light"] as const) {
        setSemanticColorTheme(mode);
        for (const text of ["GET /api/users 200 12ms", "error: x", "-rw-r--r-- 1 a b"]) {
          let previousEnd = 0;
          for (const range of semanticLine(text).ranges) {
            expect(range.start, mode + " " + text).toBeGreaterThanOrEqual(previousEnd);
            expect(range.end, mode + " " + text).toBeGreaterThan(range.start);
            expect(range.end, mode + " " + text).toBeLessThanOrEqual(text.length);
            previousEnd = range.end;
          }
        }
      }
    } finally {
      setSemanticColorTheme("dark");
    }
  });

  it("paints diff file headers in slate without a band", () => {
    for (const header of ["--- a/file.txt", "+++ b/file.txt"]) {
      const line = semanticLine(header);
      expect(line.band, header).toBeUndefined();
      expect(line.ranges[0]?.color, header).toBe(SEMANTIC_COLORS.slate);
    }
  });
});

describe("theme switching", () => {
  it("swaps palette and bands with the theme", () => {
    try {
      setSemanticColorTheme("light");
      expect(SEMANTIC_COLORS).toBe(SEMANTIC_PALETTES.light);
      expect(semanticLine("error: x").band).toBe(SEMANTIC_BANDS.light.error);
      setSemanticColorTheme("dark");
      expect(SEMANTIC_COLORS).toBe(SEMANTIC_PALETTES.dark);
      expect(semanticLine("error: x").band).toBe(SEMANTIC_BANDS.dark.error);
    } finally {
      setSemanticColorTheme("dark");
    }
  });
});
