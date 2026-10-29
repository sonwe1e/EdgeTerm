import { describe, expect, it } from "vitest";
import { INTERACTIVE_TAIL_LINES, parseLogForJumps, resolveJumpPath } from "./logJump";

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/data/vfi/train.py", line 31, in <module>',
  "    main()",
  '  File "warp.py", line 138, in forward',
  "    x = self.proj(x)",
  '  File "<frozen importlib._bootstrap>", line 241, in _call_with_frames_removed',
  '  File "<stdin>", line 1, in <module>',
  "RuntimeError: CUDA out of memory",
].join("\n");

describe("parseLogForJumps", () => {
  it("links an absolute Python frame to its file and line", () => {
    const parsed = parseLogForJumps(TRACEBACK, "/data/vfi/baseline");
    const links = parsed.lines.filter((line) => line.jump);
    expect(links).toHaveLength(2);
    expect(links[0].jump).toEqual({ path: "/data/vfi/train.py", line: 31 });
    expect(links[1].jump).toEqual({ path: "/data/vfi/baseline/warp.py", line: 138 });
  });

  it("resolves a relative frame against the run root", () => {
    expect(resolveJumpPath("src/warp.py", "/data/vfi/baseline")).toBe(
      "/data/vfi/baseline/src/warp.py",
    );
    // Trailing slashes on the root do not leak into the path.
    expect(resolveJumpPath("warp.py", "/data/vfi/baseline/")).toBe("/data/vfi/baseline/warp.py");
    // Without a root a relative frame cannot be resolved, so it stays text.
    expect(resolveJumpPath("warp.py", null)).toBeNull();
    expect(parseLogForJumps(TRACEBACK, null).lines.filter((line) => line.jump)).toHaveLength(1);
  });

  it("keeps virtual and Windows frame paths as plain text", () => {
    const parsed = parseLogForJumps(
      ['  File "<string>", line 5, in <module>', '  File "C:\\repo\\warp.py", line 9'].join("\n"),
      "/data/vfi",
    );
    expect(parsed.lines.every((line) => line.jump === null)).toBe(true);
  });

  it("does not link a File line without a line number", () => {
    const parsed = parseLogForJumps('  File "warp.py"\n', "/root");
    expect(parsed.lines[0].jump).toBeNull();
  });

  it("keeps everything before the tail bound as one plain head", () => {
    const filler = Array.from({ length: INTERACTIVE_TAIL_LINES + 40 }, (_, i) => `line ${i}`);
    const log = [...filler, '  File "warp.py", line 138, in forward'].join("\n");
    const parsed = parseLogForJumps(log, "/data/vfi");
    expect(parsed.lines).toHaveLength(INTERACTIVE_TAIL_LINES);
    expect(parsed.head).toBe(`${filler.slice(0, 41).join("\n")}\n`);
    expect(parsed.lines[parsed.lines.length - 1].jump).toEqual({
      path: "/data/vfi/warp.py",
      line: 138,
    });
  });

  it("carries the exact text so a plain render is unchanged", () => {
    const parsed = parseLogForJumps(TRACEBACK, "/data/vfi/baseline");
    expect(`${parsed.head}${parsed.lines.map((line) => line.text).join("\n")}`).toBe(TRACEBACK);
  });

  it("returns nothing for an empty log", () => {
    expect(parseLogForJumps("", "/root")).toEqual({ head: "", lines: [] });
  });
});
