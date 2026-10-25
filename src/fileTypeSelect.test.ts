import { act, createElement as h, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFileListKeyboard } from "./components/useFileListKeyboard";
import {
  TYPE_SELECT_RESET_MS,
  findByPrefix,
  foldName,
  typeToSelect,
  type TypeRun,
} from "./fileTypeSelect";
import type { FileEntry } from "./types";

const entry = (name: string): FileEntry => ({
  name,
  path: `/home/${name}`,
  isDir: false,
  isSymlink: false,
  size: 1,
  modified: null,
  permissions: null,
  owner: null,
  group: null,
});

const key = (
  value: string,
  modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "isComposing", boolean>> = {},
) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...modifiers,
});

/**
 * Types `text` into a list of `names`, a key every `gap` ms, the way the
 * panels do; the name selected after each key, or "-" for none. The list
 * starts with no active entry, and each key's entry becomes the anchor the
 * next key searches from — the selection the panel actually applies.
 */
const typeInto = (names: string[], text: string, gap = 100) => {
  const entries = names.map((name) => entry(name));
  let anchor: string | null = null;
  let run: TypeRun | null = null;
  return [...text].map((char, index) => {
    const typed = typeToSelect(entries, anchor, run, key(char), index * gap);
    if (!typed) throw new Error(`"${char}" was not taken as typing`);
    run = typed.run;
    const picked = entries[typed.index];
    if (!picked) return "-";
    anchor = picked.path;
    return picked.name;
  });
};

const home = ["Desktop", "docs", "Downloads", "etc", "Music"];

describe("typeToSelect", () => {
  it("selects the first name starting with what was typed, ignoring case", () => {
    expect(typeInto(home, "dow")).toEqual(["Desktop", "docs", "Downloads"]);
    expect(typeInto(home, "MU")).toEqual(["Music", "Music"]);
  });

  it("starts over after a pause, moving on from the active entry", () => {
    expect(typeInto(home, "dd", TYPE_SELECT_RESET_MS)).toEqual(["Desktop", "docs"]);
    expect(typeInto(home, "ddd", TYPE_SELECT_RESET_MS)).toEqual(["Desktop", "docs", "Downloads"]);
  });

  it("steps through the names a repeated letter starts", () => {
    expect(typeInto(["a", "s1", "s2", "s3"], "ssss")).toEqual(["s1", "s2", "s3", "s1"]);
    // Unless a name starts with the repeats themselves.
    expect(typeInto(["s3.txt", "src", "ssh", "sudo"], "sss")).toEqual(["s3.txt", "ssh", "sudo"]);
  });

  it("keeps the selection when no name matches", () => {
    expect(typeInto(home, "dx")).toEqual(["Desktop", "-"]);
    expect(typeInto(home, "q")).toEqual(["-"]);
  });

  it("wraps around when the active entry is the last one", () => {
    const entries = home.map((name) => entry(name));
    expect(typeToSelect(entries, entries[4].path, null, key("d"), 0)).toEqual({
      run: { text: "d", at: 0 },
      index: 0,
    });
  });

  it("searches the whole list when the active entry is no longer listed", () => {
    const entries = home.map((name) => entry(name));
    expect(typeToSelect(entries, "/home/gone", null, key("m"), 0)?.index).toBe(4);
  });

  it("takes a space only inside a run", () => {
    const entries = [entry("Mydata"), entry("My Documents")];
    expect(typeToSelect(entries, null, null, key(" "), 0)).toBeNull();
    expect(typeInto(["Mydata", "My Documents"], "my d")).toEqual([
      "Mydata",
      "Mydata",
      "My Documents",
      "My Documents",
    ]);
  });

  it("does not start a run on a space after a pause", () => {
    const entries = [entry("a"), entry("b")];
    const run: TypeRun = { text: "a", at: 0 };
    expect(typeToSelect(entries, entries[0].path, run, key(" "), TYPE_SELECT_RESET_MS)).toBeNull();
  });

  it("matches a decomposed name against a composed key", () => {
    expect(typeInto(["etc", "E\u0301cran.png"], "\u00e9")).toEqual(["E\u0301cran.png"]);
  });

  it("leaves shortcuts, named keys and composition alone", () => {
    const entries = home.map((name) => entry(name));
    const ignored = [
      key("d", { metaKey: true }),
      key("d", { ctrlKey: true }),
      key("d", { altKey: true }),
      key("d", { isComposing: true }),
      key("Enter"),
      key("ArrowDown"),
      key("Backspace"),
    ];
    for (const press of ignored) {
      expect(typeToSelect(entries, null, null, press, 0)).toBeNull();
    }
  });

  it("reports the extended run so the next key can build on it", () => {
    const entries = home.map((name) => entry(name));
    const first = typeToSelect(entries, null, null, key("d"), 0);
    expect(first).toEqual({ run: { text: "d", at: 0 }, index: 0 });
    const second = typeToSelect(entries, entries[first!.index].path, first!.run, key("o"), 100);
    expect(second).toEqual({ run: { text: "do", at: 100 }, index: 1 });
  });

  it("keeps a failed run so the next key still extends it", () => {
    const entries = home.map((name) => entry(name));
    const first = typeToSelect(entries, null, null, key("d"), 0)!;
    const miss = typeToSelect(entries, entries[first.index].path, first.run, key("z"), 100);
    expect(miss).toEqual({ run: { text: "dz", at: 100 }, index: -1 });
  });
});

describe("findByPrefix", () => {
  const entries = home.map((name) => entry(name));

  it("finds the first match from the start index, wrapping around", () => {
    expect(findByPrefix(entries, "do", 0)).toBe(1);
    expect(findByPrefix(entries, "Do", 1)).toBe(1);
    expect(findByPrefix(entries, "d", 4)).toBe(0);
    expect(findByPrefix(entries, "m", 0)).toBe(4);
  });

  it("clamps a negative start index to the top of the list", () => {
    expect(findByPrefix(entries, "e", -3)).toBe(3);
    expect(findByPrefix(entries, "", -1)).toBe(0);
  });

  it("answers -1 when no name starts with the prefix", () => {
    expect(findByPrefix(entries, "zzz", 0)).toBe(-1);
    expect(findByPrefix([], "a", 0)).toBe(-1);
  });
});

describe("foldName", () => {
  it("composes the name and lowercases it", () => {
    expect(foldName("E\u0301cran.png")).toBe("\u00e9cran.png");
    expect(foldName("README")).toBe("readme");
  });
});

// The panels own the DOM half of type-to-select through `useFileListKeyboard`.
// These run it in jsdom to prove the wiring: a typed name moves the cursor and
// the selection, the keyboard model carries on from the typed row, and the
// hook consumes nothing it was not asked to.
const optionId = (path: string) => `option-${encodeURIComponent(path)}`;
const listEntries = home.map((name) => entry(name));

/** The smallest list a type-to-select list needs: focusable listbox, rows. */
function ListHarness({
  onActivate = () => {},
  typeSelect = true,
  editor = false,
}: {
  onActivate?: (entry: FileEntry) => void;
  typeSelect?: boolean;
  editor?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { activeDescendant, onKeyDown } = useFileListKeyboard({
    entries: listEntries,
    rowHeight: 20,
    listRef,
    optionId,
    onSelect: setSelected,
    onActivate,
    typeSelect,
  });
  return h(
    "div",
    {
      ref: listRef,
      role: "listbox",
      tabIndex: 0,
      "aria-activedescendant": activeDescendant ?? undefined,
      "data-selected": selected ?? "",
      onKeyDown,
    },
    editor ? h("input", { "aria-label": "inline editor" }) : null,
    listEntries.map((item) =>
      h("div", { key: item.path, id: optionId(item.path), role: "option" }),
    ),
  );
}

describe("useFileListKeyboard type-to-select", () => {
  let host: HTMLDivElement;
  let root: Root;
  let revealed: ReturnType<typeof vi.fn>;
  let originalReveal: (() => void) | undefined;

  const listbox = () => host.querySelector<HTMLElement>('[role="listbox"]')!;
  const selected = () => listbox().dataset.selected;
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      listbox().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      );
    });

  const mount = (props: Parameters<typeof ListHarness>[0] = {}) => {
    act(() => root.render(h(ListHarness, props)));
    listbox().focus();
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no layout, so the hook's scroll-into-view needs a stub.
    const prototype = Element.prototype as unknown as { scrollIntoView?: () => void };
    originalReveal = prototype.scrollIntoView;
    revealed = vi.fn();
    // The mock's generic signature does not narrow to the DOM method's; the
    // stub only has to be callable and observable here.
    prototype.scrollIntoView = revealed as unknown as () => void;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView =
      originalReveal;
  });

  it("moves the cursor and selection to a typed name and extends the run", () => {
    mount();

    press("d");
    expect(selected()).toBe("/home/Desktop");
    expect(listbox().getAttribute("aria-activedescendant")).toBe(optionId("/home/Desktop"));
    expect(revealed).toHaveBeenCalled();

    press("o");
    expect(selected()).toBe("/home/docs");
    expect(listbox().getAttribute("aria-activedescendant")).toBe(optionId("/home/docs"));
  });

  it("leaves the keyboard model walking on from the typed row", () => {
    mount();
    press("d");
    expect(selected()).toBe("/home/Desktop");

    press("ArrowDown");
    expect(selected()).toBe("/home/docs");
    press("ArrowDown");
    expect(selected()).toBe("/home/Downloads");
  });

  it("takes Enter on the typed row, not a stale cursor", () => {
    const onActivate = vi.fn();
    mount({ onActivate });

    press("m");
    press("u");
    expect(selected()).toBe("/home/Music");
    press("Enter");
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ path: "/home/Music" }));
  });

  it("ignores shortcuts, named keys and keys typed into an inline editor", () => {
    mount({ editor: true });

    press("d", { ctrlKey: true });
    press("d", { metaKey: true });
    press("d", { altKey: true });
    press("d", { isComposing: true });
    press("Enter");
    expect(selected()).toBe("");

    // A key that bubbles up from a field inside the list is that field's text.
    const editor = host.querySelector("input")!;
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
      );
    });
    expect(selected()).toBe("");
  });

  it("takes no typed keys when the list did not opt in", () => {
    mount({ typeSelect: false });
    press("d");
    expect(selected()).toBe("");
  });
});
