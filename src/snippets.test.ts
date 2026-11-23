import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_COMMAND_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SNIPPETS,
  SNIPPETS_KEY,
  cleanCommand,
  copyName,
  loadSnippets,
  parseSnippets,
  saveSnippets,
  snippetBytes,
} from "./snippets";

beforeEach(() => {
  localStorage.clear();
});

describe("parseSnippets", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const raw = JSON.stringify([
      { id: "a", name: "Restart app", command: "sudo systemctl restart app" },
      { id: "b", name: "", command: "empty name" },
      { id: "c", name: "Blank command", command: "   " },
      { id: "d" },
      "not an object",
      { id: "a", name: "Duplicate id", command: "dupe" },
    ]);
    expect(parseSnippets(raw)).toEqual([
      { id: "a", name: "Restart app", command: "sudo systemctl restart app" },
    ]);
  });

  it("survives junk instead of throwing", () => {
    expect(parseSnippets(null)).toEqual([]);
    expect(parseSnippets("not json")).toEqual([]);
    expect(parseSnippets('{"id":"x"}')).toEqual([]);
  });

  it("strips control characters from names and caps both fields", () => {
    const [entry] = parseSnippets(
      JSON.stringify([
        {
          id: "a",
          name: "\u0007Restart\u001b app" + "x".repeat(200),
          command: "y".repeat(MAX_COMMAND_LENGTH + 50),
        },
      ]),
    );
    expect(entry.name.startsWith("Restart app")).toBe(true);
    expect(entry.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(entry.command).toHaveLength(MAX_COMMAND_LENGTH);
  });

  it("stops at the list limit", () => {
    const raw = JSON.stringify(
      Array.from({ length: MAX_SNIPPETS + 5 }, (_, index) => ({
        id: "id-" + index,
        name: "name " + index,
        command: "echo " + index,
      })),
    );
    expect(parseSnippets(raw)).toHaveLength(MAX_SNIPPETS);
  });
});

describe("persistence", () => {
  it("round-trips through storage", () => {
    const snippets = [{ id: "a", name: "Logs", command: "tail -f app.log" }];
    saveSnippets(snippets);
    expect(loadSnippets()).toEqual(snippets);
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)).toEqual(snippets);
  });

  it("reads nothing when storage holds junk", () => {
    localStorage.setItem(SNIPPETS_KEY, "}{");
    expect(loadSnippets()).toEqual([]);
  });
});

describe("sending", () => {
  it("cleans the command the reader typed", () => {
    expect(cleanCommand("  sudo ls  ")).toBe("sudo ls");
    expect(cleanCommand("echo one\necho two")).toBe("echo one\necho two");
    expect(cleanCommand("echo one\r\necho two")).toBe("echo one\necho two");
  });

  it("sends the command followed by exactly one Enter", () => {
    expect(snippetBytes("ls")).toBe("ls\r");
    expect(snippetBytes("  ls  ")).toBe("ls\r");
    // A blank line inside a pasted command becomes a real Enter in the shell.
    expect(snippetBytes("echo one\necho two")).toBe("echo one\recho two\r");
  });
});

describe("duplicating a saved command", () => {
  const one = (name: string) => ({ id: "x", name, command: "ls" });

  it("adds a copy suffix under a free name", () => {
    expect(copyName("Logs", [one("Logs")])).toBe("Logs copy");
  });

  it("counts up when the copy name is taken too", () => {
    expect(copyName("Logs", [one("Logs"), one("Logs copy")])).toBe("Logs copy 2");
    expect(copyName("Logs", [one("Logs"), one("Logs copy"), one("Logs copy 2")])).toBe(
      "Logs copy 3",
    );
  });

  it("ignores case, the way the name lookup does", () => {
    expect(copyName("Logs", [one("Logs"), one("logs COPY")])).toBe("Logs copy 2");
  });

  it("keeps the answer inside the name limit", () => {
    const long = "x".repeat(MAX_NAME_LENGTH);
    expect(copyName(long, []).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it("never hands back a name already in use", () => {
    // A name at the limit is the case that broke the first version: appending
    // then clipping produced the original name again, so the "copy" would
    // replace its source.
    const long = "x".repeat(MAX_NAME_LENGTH);
    const taken = [one(long)];
    const copy = copyName(long, taken);
    expect(copy).not.toBe(long);
    expect(copy.endsWith(" copy")).toBe(true);
    expect(taken.map((snippet) => snippet.name.toLowerCase())).not.toContain(copy.toLowerCase());
  });

  it("counts up without ever colliding, however many copies exist", () => {
    const taken = [one("Logs"), one("Logs copy"), one("Logs copy 2"), one("Logs copy 3")];
    const copy = copyName("Logs", taken);
    expect(copy).toBe("Logs copy 4");
    expect(taken.map((snippet) => snippet.name.toLowerCase())).not.toContain(copy.toLowerCase());
  });
});
