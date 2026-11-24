import { describe, expect, it, vi } from "vitest";

import {
  buildPaletteCommands,
  commandScore,
  fieldScore,
  groupCommands,
  loadRecents,
  matchRanges,
  normalizeQuery,
  pushRecent,
  quickConnectCommand,
  withoutTypedTarget,
  rankCommands,
  RECENTS_LIMIT,
  saveRecents,
  shortcutCommandId,
  type PaletteCommand,
  type PaletteSources,
} from "./commandPalette";
import { translate, type Translate } from "./i18n";
import { quickConnectLabel, type QuickTarget } from "./quickConnect";
import { COMMAND_RECENTS_KEY } from "./persistKeys";
import { defaultShortcuts, type KeyChord } from "./shortcuts";

// The catalogue and the ranking are the part of the palette that has to be
// right without a browser: what a command is called, what it matches, and in
// what order the list answers.

const chinese: Translate = (key, params) => translate("zh-CN", key, params);
const english: Translate = (key, params) => translate("en", key, params);

const fakeStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const chord = (code: string, mods: Partial<Omit<KeyChord, "code">> = {}): KeyChord => ({
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  code,
  ...mods,
});

const sources = (over: Partial<PaletteSources> = {}): PaletteSources => ({
  t: english,
  shortcuts: defaultShortcuts(),
  theme: "dark",
  tabs: [{ id: "tab-1", title: "Build server", hint: "build@build.internal:22" }],
  profiles: [{ id: "profile-1", name: "prod-db", hint: "ssh · root@db.internal" }],
  actions: {
    runShortcut: vi.fn(),
    activateTab: vi.fn(),
    connectProfile: vi.fn(),
    setTheme: vi.fn(),
    openDisplaySettings: vi.fn(),
    openShortcutSettings: vi.fn(),
    openSettings: vi.fn(),
    openAbout: vi.fn(),
    checkForUpdates: vi.fn(),
    importSshConfig: vi.fn(),
  },
  ...over,
});

const command = (
  over: Partial<PaletteCommand> & { id: string; label: string },
): PaletteCommand => ({
  group: "actions",
  keywords: [],
  run: () => {},
  ...over,
});

describe("query normalisation", () => {
  it("ignores case and collapses the spaces a paste can bring", () => {
    expect(normalizeQuery("  New   Session ")).toBe("new session");
    expect(normalizeQuery("\t")).toBe("");
  });
});

describe("the match ladder", () => {
  it("ranks exact, prefix, word start, substring and subsequence in that order", () => {
    const exact = fieldScore("find", "find");
    const prefix = fieldScore("find next", "find");
    const wordStart = fieldScore("hide find", "find");
    const substring = fieldScore("refind", "find");
    const subsequence = fieldScore("f-i-n-d", "find");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
    expect(fieldScore("sessions", "find")).toBe(-1);
  });

  it("never matches a query whose characters are out of order", () => {
    expect(fieldScore("dni f", "find")).toBe(-1);
  });

  it("scores a Chinese label by substring, without needing Latin word breaks", () => {
    expect(fieldScore("新建会话", "会话")).toBeGreaterThan(0);
    expect(fieldScore("新建会话", "新建")).toBeGreaterThan(fieldScore("新建会话", "会话"));
  });
});

describe("commandScore", () => {
  it("falls back to the hidden search terms and then to the hint", () => {
    const withKeyword = command({ id: "k", label: "命令面板", keywords: ["command palette"] });
    expect(commandScore(withKeyword, "command palette")).toBeGreaterThan(0);
    const withHint = command({ id: "h", label: "面板", hint: "show the sessions list" });
    expect(commandScore(withHint, "sessions")).toBeGreaterThan(0);
  });

  it("prefers the label over the hint for the same word", () => {
    const labelled = command({ id: "a", label: "sessions" });
    const hinted = command({ id: "b", label: "open", hint: "sessions" });
    expect(commandScore(labelled, "sessions")).toBeGreaterThan(commandScore(hinted, "sessions"));
  });
});

describe("ranking", () => {
  const commands = [
    command({ id: "a", label: "New Session" }),
    command({ id: "b", label: "Close Session" }),
    command({ id: "c", label: "Find" }),
    command({ id: "d", label: "Find Next" }),
  ];

  it("keeps the catalogue order for an empty query, so Enter is predictable", () => {
    expect(rankCommands(commands, "  ").map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("puts the exact label first when the query is complete", () => {
    expect(rankCommands(commands, "find").map((item) => item.id)).toEqual(["c", "d"]);
    expect(rankCommands(commands, "find next")[0].id).toBe("d");
  });

  it("drops commands that do not match at all", () => {
    expect(rankCommands(commands, "zzz")).toEqual([]);
  });

  it("lifts a recently run command to the front among equally good matches", () => {
    const ranked = rankCommands(commands, "session", ["b"]);
    expect(ranked.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("keeps catalogue order for ties, so the list never twitches between runs", () => {
    const tied = [command({ id: "x", label: "run a" }), command({ id: "y", label: "run b" })];
    expect(rankCommands(tied, "run").map((item) => item.id)).toEqual(["x", "y"]);
    expect(rankCommands(tied, "run").map((item) => item.id)).toEqual(["x", "y"]);
  });
});

describe("match ranges", () => {
  it("marks the substring when there is one", () => {
    expect(matchRanges("New Session", "session")).toEqual([[4, 11]]);
  });

  it("merges touching subsequence characters and skips the gaps", () => {
    expect(matchRanges("New Session", "ns")).toEqual([
      [0, 1],
      [4, 5],
    ]);
    expect(matchRanges("New Session", "nw")).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("marks nothing for a query that does not match", () => {
    expect(matchRanges("New Session", "zz")).toEqual([]);
    expect(matchRanges("New Session", "")).toEqual([]);
  });
});

describe("recents", () => {
  it("keeps the newest first, deduplicated and bounded", () => {
    let list: string[] = [];
    for (let index = 0; index < RECENTS_LIMIT + 4; index++)
      list = pushRecent(list, "command-" + index);
    expect(list).toHaveLength(RECENTS_LIMIT);
    expect(list[0]).toBe("command-" + (RECENTS_LIMIT + 3));
    expect(pushRecent(["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("round-trips through storage and rejects anything that is not a list of ids", () => {
    const storage = fakeStorage();
    saveRecents(["a", "b"], storage);
    expect(storage.values.get(COMMAND_RECENTS_KEY)).toBe('["a","b"]');
    expect(loadRecents(storage)).toEqual(["a", "b"]);

    storage.setItem(COMMAND_RECENTS_KEY, "not json");
    expect(loadRecents(storage)).toEqual([]);
    storage.setItem(COMMAND_RECENTS_KEY, '{"a":1}');
    expect(loadRecents(storage)).toEqual([]);
    storage.setItem(COMMAND_RECENTS_KEY, '[1,"ok","ok",""]');
    expect(loadRecents(storage)).toEqual(["ok"]);
    expect(loadRecents(null)).toEqual([]);
  });
});

describe("the catalogue", () => {
  it("builds unique ids with a label, a group and the shortcut table behind it", () => {
    const commands = buildPaletteCommands(sources());
    expect(commands.length).toBeGreaterThan(20);
    const ids = commands.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of commands) expect(item.label.trim().length).toBeGreaterThan(0);
    expect(ids).toContain(shortcutCommandId("newSession"));
    expect(ids).toContain(shortcutCommandId("panelSessions"));
    expect(ids).toContain("theme:serialx-light");
    expect(ids).toContain("tab:tab-1");
    expect(ids).toContain("session:profile-1");
  });

  it("marks a session the reader connected to recently, and only that one", () => {
    const plain = buildPaletteCommands(sources());
    expect(plain.find((item) => item.id === "session:profile-1")?.hint).not.toContain(
      english("palette.usedRecently"),
    );
    const marked = buildPaletteCommands(sources({ recentProfiles: ["profile-1"] }));
    const hint = marked.find((item) => item.id === "session:profile-1")?.hint ?? "";
    expect(hint).toContain(english("palette.usedRecently"));
    // The address and the verb stay: the mark is added, not substituted.
    expect(hint).toContain("root@db.internal");
    expect(hint).toContain(english("palette.connectHint"));
  });

  it("finds a session by the address its hint shows", () => {
    // Ctrl+P is where a reader types an address as readily as in the tree's
    // filter: the hint carries "root@db.internal", so the query must find it.
    const found = rankCommands(buildPaletteCommands(sources()), "db.internal").map(
      (item) => item.id,
    );
    expect(found).toContain("session:profile-1");
    const byUser = rankCommands(buildPaletteCommands(sources()), "root@").map((item) => item.id);
    expect(byUser).toContain("session:profile-1");
  });

  it("finds a session by the port its hint carries", () => {
    // App builds this hint (kind · user@host:port · verb); the palette finds the
    // row because a hint counts towards the score, port included.
    const withPort = {
      id: "session:profile-1",
      group: "sessions" as const,
      label: "Connect to Build server",
      hint: "ssh · build@build.internal:2222 · Connect",
      keywords: ["connect", "session", "Build server"],
      run: () => undefined,
    };
    expect(rankCommands([withPort], "2222").map((item) => item.id)).toEqual(["session:profile-1"]);
    expect(rankCommands([withPort], "build.internal:2222").map((item) => item.id)).toEqual([
      "session:profile-1",
    ]);
  });

  it("files commands under the group a reader would look in", () => {
    const commands = buildPaletteCommands(sources());
    const group = (id: string) => commands.find((item) => item.id === id)?.group;
    expect(group(shortcutCommandId("newSession"))).toBe("actions");
    expect(group(shortcutCommandId("splitRight"))).toBe("layout");
    expect(group(shortcutCommandId("panelFiler"))).toBe("panels");
    expect(group("tab:tab-1")).toBe("tabs");
    expect(group("session:profile-1")).toBe("sessions");
    expect(group("theme:dark")).toBe("appearance");
    expect(group("settings:display")).toBe("settings");
  });

  it("shows a rebound chord rather than the built-in default", () => {
    const shortcuts = {
      ...defaultShortcuts(),
      newSession: chord("KeyN", { ctrl: true, shift: true }),
    };
    const commands = buildPaletteCommands(sources({ shortcuts }));
    const item = commands.find((entry) => entry.id === shortcutCommandId("newSession"))!;
    expect(item.chord).toBe("Ctrl+Shift+N");
  });

  it("marks only the active theme and runs the chosen one", () => {
    const actions = sources().actions;
    const commands = buildPaletteCommands(sources({ theme: "serialx-dark", actions }));
    const current = commands.find((item) => item.id === "theme:serialx-dark")!;
    const other = commands.find((item) => item.id === "theme:light")!;
    expect(current.hint).toBe("Current");
    expect(other.hint).toBeUndefined();
    other.run();
    expect(actions.setTheme).toHaveBeenCalledWith("light");
  });

  it("reuses the menus' own wording for the settings entries", () => {
    const commands = buildPaletteCommands(sources());
    const labels = commands.filter((item) => item.group === "settings").map((item) => item.label);
    expect(labels).toContain("Display Settings…");
    expect(labels).toContain("Keyboard Shortcuts…");
    expect(labels).toContain("About EdgeTerm");
    expect(labels).toContain("Import OpenSSH Config…");
  });

  it("runs the injected action for a tab, a session and a shortcut", () => {
    const base = sources();
    const commands = buildPaletteCommands(base);
    commands.find((item) => item.id === "tab:tab-1")!.run();
    expect(base.actions.activateTab).toHaveBeenCalledWith("tab-1");
    commands.find((item) => item.id === "session:profile-1")!.run();
    expect(base.actions.connectProfile).toHaveBeenCalledWith("profile-1");
    commands.find((item) => item.id === shortcutCommandId("find"))!.run();
    expect(base.actions.runShortcut).toHaveBeenCalledWith({ kind: "find" });
  });

  it("can be searched in English while the interface is Chinese", () => {
    const commands = buildPaletteCommands(sources({ t: chinese }));
    const ranked = rankCommands(commands, "new session");
    expect(ranked[0]?.id).toBe(shortcutCommandId("newSession"));
    // The visible label stays Chinese.
    expect(commands.find((item) => item.id === shortcutCommandId("newSession"))!.label).toBe(
      translate("zh-CN", "sc.newSession.label"),
    );
    const chineseQuery = rankCommands(commands, "新建");
    expect(chineseQuery[0]?.id).toBe(shortcutCommandId("newSession"));
  });

  it("omits the SSH import entry when the host offers no importer", () => {
    const base = sources();
    const withoutImporter: PaletteSources = {
      ...base,
      actions: { ...base.actions, importSshConfig: undefined },
    };
    const ids = buildPaletteCommands(withoutImporter).map((item) => item.id);
    expect(ids).not.toContain("settings:sshConfig");
    expect(ids).toContain("settings:display");
  });
});
describe("sections", () => {
  const commands = [
    command({ id: "a1", group: "actions", label: "New Session" }),
    command({ id: "l1", group: "layout", label: "Split Right" }),
    command({ id: "a2", group: "actions", label: "Close Session" }),
    command({ id: "p1", group: "panels", label: "Sessions Panel" }),
    command({ id: "l2", group: "layout", label: "Next Pane" }),
  ];

  it("keeps one heading per group and the catalogue's order when nothing is typed", () => {
    const ranked = rankCommands(commands, "");
    const sections = groupCommands(ranked, "");
    expect(sections.map((section) => section.id)).toEqual(["actions", "layout", "panels"]);
    expect(sections[0].commands.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(sections[1].commands.map((item) => item.id)).toEqual(["l1", "l2"]);
  });

  it("orders sections by their best match while searching, never repeating a heading", () => {
    const ranked = rankCommands(commands, "split");
    const sections = groupCommands(ranked, "split");
    expect(sections.map((section) => section.id)).toEqual(["layout"]);
    expect(sections.flatMap((section) => section.commands.map((item) => item.id))).toEqual(["l1"]);
    expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
  });

  it("flattens to exactly the command count the footer reports", () => {
    for (const query of ["", "session", "p", "zzz"]) {
      const ranked = rankCommands(commands, query);
      const flat = groupCommands(ranked, query).flatMap((section) => section.commands);
      expect(flat).toHaveLength(ranked.length);
      expect(new Set(flat.map((item) => item.id)).size).toBe(ranked.length);
    }
  });
});
describe("the palette itself", () => {
  it("is not one of its own rows", () => {
    const ids = buildPaletteCommands(sources()).map((item) => item.id);
    expect(ids).not.toContain(shortcutCommandId("commandPalette"));
    // Every other command in the table is offered.
    for (const id of ["newSession", "closeSession", "find", "panelSessions"] as const) {
      expect(ids).toContain(shortcutCommandId(id));
    }
  });
});

it("files the connect row as an action, not as a saved session", () => {
  const command = quickConnectCommand(
    { host: "example.com", username: null, port: null },
    ((key: string) => key) as unknown as Translate,
    () => {},
  );
  // The row's promise is that the session is not saved, so the heading it sits
  // under must not claim otherwise.
  expect(command.group).toBe("actions");
});

describe("the settings group", () => {
  it("opens the settings surface itself, not just its sub-dialogs", () => {
    const fixture = sources();
    const catalogue = buildPaletteCommands(fixture);
    const row = catalogue.find((item) => item.id === "settings:all");
    expect(row, "the palette can reach the settings surface").toBeTruthy();
    expect(row!.group).toBe("settings");
    // Language, restore-defaults and export/import live only on that surface,
    // so a palette-first reader needs this row to find them at all.
    const found = rankCommands(catalogue, "language").map((item) => item.id);
    expect(found).toContain("settings:all");
    row!.run();
    expect(fixture.actions.openSettings).toHaveBeenCalled();
  });

  it("finds that surface by the words its controls use in a translated interface", () => {
    // A Chinese reader searches the words on the controls — 语言, 恢复默认,
    // 导出 — not the English keywords, so the row carries those too.
    const catalogue = buildPaletteCommands(sources({ t: chinese }));
    for (const query of ["语言", "恢复默认", "导出"]) {
      expect(rankCommands(catalogue, query).map((item) => item.id)).toContain("settings:all");
    }
  });
});

describe("remembered quick targets", () => {
  it("drops a remembered target the field already offers, and nothing else", () => {
    // Both rows are built from the same label, so keeping both means one id for
    // two rows: React keys collide and the row Enter runs is not the selected one.
    const typed: QuickTarget = { host: "10.0.0.5", username: "root", port: 2222 };
    const other: QuickTarget = { host: "db.internal", username: "ops", port: 22 };
    expect(withoutTypedTarget([typed, other], quickConnectLabel(typed))).toEqual([other]);
    expect(withoutTypedTarget([typed, other], null), "no typed row, nothing dropped").toEqual([
      typed,
      other,
    ]);
    expect(withoutTypedTarget([typed], quickConnectLabel(other))).toEqual([typed]);
  });
});
