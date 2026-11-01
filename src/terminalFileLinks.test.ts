import { type ILink, Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CwdAttribution,
  createFileLinkProvider,
  type FileLinkProviderOptions,
  parseFileLinks,
  type TerminalFileLinkTarget,
} from "./terminalFileLinks";

const terminals: Terminal[] = [];

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

async function terminalWith(text: string, cols = 80): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows: 5, scrollback: 100 });
  terminals.push(terminal);
  await write(terminal, text);
  return terminal;
}

const mouseUp = (init: MouseEventInit = {}) =>
  new MouseEvent("mouseup", { cancelable: true, button: 0, ...init });

function provide(
  terminal: Terminal,
  bufferLineNumber: number,
  overrides: Partial<FileLinkProviderOptions> = {},
): Promise<ILink[] | undefined> {
  const provider = createFileLinkProvider({
    terminal,
    getCwdForLine: () => null,
    openLink: () => {},
    isMouseTracking: () => false,
    ...overrides,
  });
  return new Promise((resolve) => provider.provideLinks(bufferLineNumber, resolve));
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("parseFileLinks", () => {
  const cases: [string, string, number | undefined][] = [
    ['File "/srv/train/model.py", line 238', "/srv/train/model.py", 238],
    ["File '/srv/train/model.py', line 12", "/srv/train/model.py", 12],
    ['  File "/app/src/data.json", line 7, in <module>', "/app/src/data.json", 7],
    ['File "/srv/my project/train.py", line 9', "/srv/my project/train.py", 9],
    ['File "/srv/train/model.py"', "/srv/train/model.py", undefined],
    ["/path/train.py:120", "/path/train.py", 120],
    ["/path/train.py:120:8", "/path/train.py", 120],
    ["src/model.py:238", "src/model.py", 238],
    ["./run.sh:3", "./run.sh", 3],
    ["model.py:12", "model.py", 12],
    ['error: "/etc/example.conf" is missing', "/etc/example.conf", undefined],
    ["(/opt/app/main.py)", "/opt/app/main.py", undefined],
    ["[src/model.py]", "src/model.py", undefined],
    ["see /var/log/app.log now", "/var/log/app.log", undefined],
    ["    at run (/app/src/main.js:10:15)", "/app/src/main.js", 10],
    ["src/app.py:12:def main():", "src/app.py", 12],
    ["--output=/srv/run.log", "/srv/run.log", undefined],
  ];

  it.each(cases)("finds the file reference in %s", (line, path, lineNumber) => {
    const [match] = parseFileLinks(line);
    expect(match).toBeDefined();
    expect(match.path).toBe(path);
    expect(match.line).toBe(lineNumber);
  });

  const ignored = [
    "http://localhost:6000/report.html",
    "https://example.com/a/b.py",
    "see http://x/y.py:12",
    "a:b",
    "10:30",
    "23:59:59",
    "1.2.3",
    "e.g.",
    "and/or",
    "C:\\Users\\me\\main.py",
    "C:/Users/me/main.py:12",
    'File "C:\\app\\main.py", line 3',
    "/home/user/",
    "/path/train.py:0",
    "/path/train.py:10000001",
    'File "/x/y.py", line 10000001',
    "node:internal/modules/cjs/loader:1145",
  ];

  it.each(ignored)("ignores %s", (line) => {
    expect(parseFileLinks(line)).toEqual([]);
  });

  it("keeps the printed span of the whole reference, suffix included", () => {
    expect(parseFileLinks("at /srv/train.py:238")).toEqual([
      { start: 3, length: 17, path: "/srv/train.py", line: 238 },
    ]);
    expect(parseFileLinks('File "/srv/train.py", line 238')).toEqual([
      { start: 6, length: 13, path: "/srv/train.py", line: 238 },
    ]);
  });

  it("finds every reference on the line", () => {
    expect(parseFileLinks('opened "/srv/a.py:1" and /srv/b.py:2').map((m) => m.path)).toEqual([
      "/srv/a.py",
      "/srv/b.py",
    ]);
  });

  it("rejects a token longer than the path limit", () => {
    expect(parseFileLinks("/" + "a/".repeat(600) + "model.py")).toEqual([]);
  });
});

describe("CwdAttribution", () => {
  it("resolves the last report at or before the line", () => {
    const attribution = new CwdAttribution();
    attribution.record(120, "/home/u/project");
    attribution.record(180, "/srv/run");
    expect(attribution.resolve(119)).toBeNull();
    expect(attribution.resolve(120)).toBe("/home/u/project");
    expect(attribution.resolve(179)).toBe("/home/u/project");
    expect(attribution.resolve(180)).toBe("/srv/run");
    expect(attribution.resolve(4000)).toBe("/srv/run");
  });

  it("keeps the report of a line after the scrollback dropped older output", () => {
    const attribution = new CwdAttribution();
    // Stable lines: the caller adds the number of dropped lines to the buffer
    // row, so a trim moves neither the reports nor the clicked line here.
    attribution.record(120, "/home/u/project");
    attribution.record(180, "/srv/run");
    const dropped = 100;
    expect(attribution.resolve(45 + dropped)).toBe("/home/u/project");
    expect(attribution.resolve(85 + dropped)).toBe("/srv/run");
  });

  it("keeps the newest report on the same line and drops the oldest ones", () => {
    const attribution = new CwdAttribution();
    attribution.record(10, "/old");
    attribution.record(10, "/new");
    expect(attribution.resolve(10)).toBe("/new");
    for (let index = 0; index < 220; index++) {
      attribution.record(100 + index, "/dir/" + index);
    }
    expect(attribution.resolve(119)).toBeNull();
    expect(attribution.resolve(120)).toBe("/dir/20");
    expect(attribution.resolve(319)).toBe("/dir/219");
  });

  it("forgets every report on reset", () => {
    const attribution = new CwdAttribution();
    attribution.record(10, "/home/u");
    expect(attribution.resolve(10)).toBe("/home/u");
    attribution.reset();
    expect(attribution.resolve(10)).toBeNull();
  });
});

describe("createFileLinkProvider", () => {
  it("gives xterm the path, the line and the printed range", async () => {
    const terminal = await terminalWith('File "/srv/train.py", line 238');
    const links = await provide(terminal, 1);
    expect(links).toHaveLength(1);
    const link = links![0];
    expect(link.text).toBe("/srv/train.py");
    expect(link.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 19, y: 1 } });
    // Hovering must not start any work: no hover callback exists at all.
    expect(link.hover).toBeUndefined();
    expect(link.leave).toBeUndefined();
  });

  it("counts wide characters as two columns when placing the range", async () => {
    const terminal = await terminalWith("[错误] /home/u/model.py:238");
    const links = await provide(terminal, 1);
    expect(links?.[0]?.text).toBe("/home/u/model.py:238");
    // The path starts after five characters but seven display columns; a
    // character-index range would underline the wrong cells.
    expect(links?.[0]?.range).toEqual({ start: { x: 8, y: 1 }, end: { x: 27, y: 1 } });
  });

  it("opens only on a Ctrl or Cmd click and passes the anchored directory", async () => {
    const opened: TerminalFileLinkTarget[] = [];
    const getCwdForLine = vi.fn(() => "/home/u/project");
    const terminal = await terminalWith("error in src/model.py:238");
    const links = await provide(terminal, 1, {
      openLink: (target) => opened.push(target),
      getCwdForLine,
    });
    expect(links).toHaveLength(1);
    const link = links![0];

    const plain = mouseUp();
    link.activate(plain, link.text);
    expect(opened).toEqual([]);
    expect(plain.defaultPrevented).toBe(false);

    const controlled = mouseUp({ ctrlKey: true });
    link.activate(controlled, link.text);
    expect(controlled.defaultPrevented).toBe(true);
    link.activate(mouseUp({ metaKey: true }), link.text);
    expect(opened).toEqual([
      { path: "src/model.py", line: 238, cwd: "/home/u/project" },
      { path: "src/model.py", line: 238, cwd: "/home/u/project" },
    ]);
    expect(getCwdForLine).toHaveBeenCalledWith(1);
  });

  it("does not ask for a directory to resolve an absolute path", async () => {
    const opened: TerminalFileLinkTarget[] = [];
    const getCwdForLine = vi.fn(() => "/home/u");
    const terminal = await terminalWith('File "/srv/train.py", line 12');
    const links = await provide(terminal, 1, {
      openLink: (target) => opened.push(target),
      getCwdForLine,
    });
    links![0].activate(mouseUp({ ctrlKey: true }), links![0].text);
    expect(opened).toEqual([{ path: "/srv/train.py", line: 12, cwd: null }]);
    expect(getCwdForLine).not.toHaveBeenCalled();
  });

  it("stays out of a TUI that owns the mouse", async () => {
    let tracking = false;
    const opened: TerminalFileLinkTarget[] = [];
    const terminal = await terminalWith('File "/srv/train.py", line 12');
    const links = await provide(terminal, 1, {
      isMouseTracking: () => tracking,
      openLink: (target) => opened.push(target),
    });
    expect(links).toHaveLength(1);
    tracking = true;
    links![0].activate(mouseUp({ ctrlKey: true }), links![0].text);
    expect(opened).toEqual([]);
    expect(await provide(terminal, 1, { isMouseTracking: () => true })).toBeUndefined();
  });

  it("does not link a fragment on a wrapped row", async () => {
    const left = await terminalWith("aaaaaaaaaaaaaa /srv/model.py:238", 20);
    expect(await provide(left, 2)).toBeUndefined();

    const right = await terminalWith("/srv/abcdef/model.py:238XXXX", 24);
    expect(await provide(right, 1)).toBeUndefined();

    // Control: the same path on an unwrapped row is a link.
    const complete = await terminalWith("/srv/abcdef/model.py:238", 24);
    expect(await provide(complete, 1)).toHaveLength(1);
  });

  it("offers nothing for a line without a reference", async () => {
    const terminal = await terminalWith("$ ls -la");
    expect(await provide(terminal, 1)).toBeUndefined();
    expect(await provide(terminal, 99)).toBeUndefined();
  });
});
