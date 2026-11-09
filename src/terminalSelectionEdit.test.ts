import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));

import { TerminalController } from "./terminal";

// The keyboard funnel is exercised exactly as xterm delivers it: through the
// controller's own filterKey (a private member, reached the way
// terminalKeys.test.ts reaches it), with a real attached terminal so the
// selection service exists, and the prompt line written into the buffer the
// way session output arrives. Everything asserted below is the byte stream
// the session would receive (callbacks.onData) plus the filter's verdict.
const controllers: TerminalController[] = [];
const roots: HTMLElement[] = [];

function fixture(cols?: number) {
  const data = vi.fn();
  const controller = new TerminalController(
    "selection-edit-test",
    {
      onData: data,
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  const root = document.createElement("div");
  document.body.append(root);
  controller.attach(root);
  if (cols !== undefined) controller.term.resize(cols, 6);
  controllers.push(controller);
  roots.push(root);
  return { controller, data };
}

const write = (controller: TerminalController, text: string) =>
  new Promise<void>((resolve) => controller.term.write(text, resolve));

/** A keydown as xterm's key filter receives it (terminalKeys.test.ts). */
function press(
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {},
  key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : code,
) {
  const event = {
    type: "keydown",
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...modifiers,
  };
  return event as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

const filter = (controller: TerminalController, event: KeyboardEvent) =>
  (
    controller as unknown as { keyboard: { filterKey(event: KeyboardEvent): boolean } }
  ).keyboard.filterKey(event);

const select = (controller: TerminalController, col: number, row: number, length: number) =>
  controller.term.select(col, row, length);

/**
 * "\x1b[D" × walk + "\x1b[3~" × deletes + "\x1b[C" × (walk − deletes) — a
 * pure delete walks the shell cursor back to where it began, so the text after
 * the selection is input again and the next selection can be edited.
 */
const walkDelete = (walkLeft: number, deletes: number) =>
  "\x1b[D".repeat(walkLeft) + "\x1b[3~".repeat(deletes) + "\x1b[C".repeat(walkLeft - deletes);

/** The same walk and delete without the walk back: what a replacement sends first. */
const walkAndDelete = (walkLeft: number, deletes: number) =>
  "\x1b[D".repeat(walkLeft) + "\x1b[3~".repeat(deletes);

/** Lets the task that carries a replacement's walk back run. */
const settleRestore = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const root of roots.splice(0)) root.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

// The cell contract the snap and the character counting rest on, pinned so
// an xterm upgrade that changes it fails here with a reason, not silently
// in the edit math.
describe("wide-character cell semantics (probe)", () => {
  it("marks the trailing half of a wide character as width 0 with no chars", async () => {
    const { controller } = fixture();
    await write(controller, "中文ab");
    const line = controller.term.buffer.active.getLine(0)!;
    expect(line.getCell(0)?.getWidth()).toBe(2);
    expect(line.getCell(0)?.getChars()).toBe("中");
    expect(line.getCell(1)?.getWidth()).toBe(0);
    expect(line.getCell(1)?.getChars()).toBe("");
  });

  it("counts wide characters once and includes one cut by the range end", async () => {
    const { controller } = fixture();
    await write(controller, "中文ab");
    const line = controller.term.buffer.active.getLine(0)!;
    expect(controller.term.buffer.active.cursorX).toBe(6);
    expect(line.translateToString(false, 0, 6)).toBe("中文ab");
    // Four cells [2, 6) hold three characters: 文 (wide, one) + ab.
    expect(line.translateToString(false, 2, 6)).toBe("文ab");
    expect(line.translateToString(false, 2, 6).length).toBe(3);
    // An exclusive end on 中's trailing cell (1) or the cell after it (2)
    // still covers the whole character.
    expect(line.translateToString(false, 0, 1)).toBe("中");
    expect(line.translateToString(false, 0, 2)).toBe("中");
  });

  it("selects by cells and reports buffer-absolute rows", async () => {
    const { controller } = fixture();
    await write(controller, "one\r\ntwo中文");
    select(controller, 1, 1, 2);
    expect(controller.term.getSelectionPosition()).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 3, y: 1 },
    });
    // Zero width is no selection at all.
    select(controller, 1, 1, 0);
    expect(controller.term.hasSelection()).toBe(false);
    expect(controller.term.getSelectionPosition()).toBeUndefined();
  });
});

describe("deleting and replacing a selection on the input line", () => {
  it("deletes the selection with a bare Delete", async () => {
    const { controller, data } = fixture();
    // "$ echo hello world": prompt ends at column 1, "hello" at [7, 12),
    // cursor at 18, so the walk is 11 characters and the delete 5.
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);

    const del = press("Delete");
    expect(filter(controller, del)).toBe(false);
    expect(del.preventDefault).toHaveBeenCalled();
    expect(data).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledWith(walkDelete(11, 5));
    expect(controller.term.hasSelection()).toBe(false);
  });

  it("deletes the selection with a bare Backspace", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);

    expect(filter(controller, press("Backspace"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(11, 5));
  });

  it("edits the next unsubmitted Bash line after a Conda prompt changes directory", async () => {
    const { controller, data } = fixture();
    await write(controller, "(base) alice@server:~/old$ ");
    controller.term.input("cd ../new", true);
    await write(controller, "cd ../new");
    controller.term.input("\r", true);

    const prompt = "(base) alice@server:~/new$ ";
    await write(controller, `\r\n${prompt}`);
    await write(controller, "echo hello");
    expect(controller.agentDiagnostics().commandRunning).toBe(false);
    expect(controller.term.buffer.active.cursorX).toBe(prompt.length + 10);
    select(controller, prompt.length + 5, 1, 5);
    expect(controller.term.getSelectionPosition()).toEqual({
      start: { x: prompt.length + 5, y: 1 },
      end: { x: prompt.length + 10, y: 1 },
    });
    data.mockClear();

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(5, 5));
  });

  it("deletes a second selection after the shell redraws the shortened line", async () => {
    const { controller, data } = fixture();
    // The reported defect: the first edit used to leave the shell's cursor at
    // the selection's start, so a second selection ending to its right was
    // refused and only a single Delete at the cursor went out.
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenLastCalledWith(walkDelete(11, 5));

    // The shell redraws the shortened line, erases the stale tail and leaves
    // its cursor at the end: the state the real session ends up in.
    await write(controller, "\r$ echo  world\x1b[K");
    expect(controller.term.buffer.active.cursorX).toBe(13);
    select(controller, 8, 0, 5);
    data.mockClear();

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenLastCalledWith(walkDelete(5, 5));
  });

  it("counts an astral character as one step", async () => {
    const { controller, data } = fixture();
    // "$ 😀ab": the emoji occupies cells 2-3, so the cursor is at 6 and the
    // three characters to its left are 😀, a and b — not four UTF-16 units.
    await write(controller, "$ 😀ab");
    select(controller, 2, 0, 2);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenLastCalledWith(walkDelete(3, 1));
  });

  it("sends the delete before a printable key and lets xterm type the character", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);

    // True hands the key to xterm, whose keypress sends the character after
    // the synchronous term.input above — replace, not delete-then-type. The
    // walk back follows the character so it cannot land in the hole.
    expect(filter(controller, press("KeyX"))).toBe(true);
    expect(data).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledWith(walkAndDelete(11, 5));
    expect(controller.term.hasSelection()).toBe(false);

    await settleRestore();
    expect(data).toHaveBeenLastCalledWith("\x1b[C".repeat(6));
  });

  it("replaces with a shifted printable key and walks back after it", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);

    expect(filter(controller, press("KeyX", { shiftKey: true }, "X"))).toBe(true);
    expect(data).toHaveBeenCalledWith(walkAndDelete(11, 5));
    await settleRestore();
    expect(data).toHaveBeenLastCalledWith("\x1b[C".repeat(6));
  });

  it("counts characters, not cells, across wide characters", async () => {
    const { controller, data } = fixture();
    // "$ 中文ab": 中 at cells 2-3, 文 at 4-5, cursor at 8. Selecting both
    // CJK characters walks 4 characters (中文ab) and deletes 2.
    await write(controller, "$ 中文ab");
    select(controller, 2, 0, 4);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(4, 2));
  });

  it("snaps a selection start on the trailing half of a wide character back", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ 中文ab");
    // Start at cell 3 (second half of 中): the character still owns the
    // edit, same sequence as selecting from its leading cell.
    select(controller, 3, 0, 3);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(4, 2));
  });

  it("keeps a wide character cut by the selection end in the count", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ 中文ab");
    // End at cell 4 (leading cell of 文): [2, 4) covers exactly 中.
    select(controller, 2, 0, 2);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(4, 1));
  });

  it("counts across the rows of a soft-wrapped logical line", async () => {
    const { controller, data } = fixture(20);
    await write(controller, "$ abcdefghijklmnopqrstu");
    const buf = controller.term.buffer.active;
    expect(buf.getLine(1)?.isWrapped).toBe(true);
    expect(buf.baseY + buf.cursorY).toBe(1);
    expect(buf.cursorX).toBe(3);
    // [17, 20) on row 0 ("pqr") plus [0, 3) on row 1 ("stu"); the cursor
    // sits at the selection's end, so the walk equals the delete count.
    select(controller, 17, 0, 6);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(6, 6));
  });

  it("edits from column 0 when the prompt is not recognized", async () => {
    const { controller, data } = fixture();
    await write(controller, "echo hi");
    select(controller, 0, 0, 2);

    expect(filter(controller, press("Delete"))).toBe(false);
    expect(data).toHaveBeenCalledWith(walkDelete(7, 2));
  });
});

describe("selections the shell must judge, not the editor", () => {
  /** Deletes into a selection that must not be editable: nothing is sent. */
  const untouched = async (setup: (made: ReturnType<typeof fixture>) => Promise<void> | void) => {
    const made = fixture();
    await setup(made);
    const input = vi.spyOn(made.controller.term, "input");
    const del = press("Delete");
    expect(filter(made.controller, del)).toBe(true);
    expect(del.preventDefault).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(made.data).not.toHaveBeenCalled();
  };

  it("leaves a selection reaching past the cursor alone (zsh autosuggestion)", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "$ ab");
      select(controller, 3, 0, 3);
    });
  });

  it("leaves a selection on an output line alone", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "result line\r\n$ hi");
      select(controller, 0, 0, 6);
    });
  });

  it("leaves a selection inside a recognized prompt alone", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "$ echo");
      select(controller, 0, 0, 1);
    });
  });

  it("protects the Conda prompt prefix while allowing its typed command", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "(base) alice@server:~/work$ echo hello");
      select(controller, 0, 0, 6);
    });
  });

  it("leaves every selection alone while a command is running", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "$ ls");
      expect(controller.noteCommandSent("ls")).toBe(true);
      select(controller, 3, 0, 2);
    });
  });

  it("leaves every selection alone while the terminal is locked", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "$ ls");
      select(controller, 3, 0, 2);
      controller.setLocked(true);
    });
  });

  it("leaves every selection alone in the alternate buffer", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "\x1b[?1049h");
      select(controller, 0, 0, 4);
    });
  });

  it("leaves every selection alone while a program tracks the mouse", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "\x1b[?1000h");
      select(controller, 0, 0, 4);
    });
  });

  it("leaves a zero-width selection alone", async () => {
    await untouched(async ({ controller }) => {
      await write(controller, "$ ab");
      select(controller, 2, 0, 0);
    });
  });

  it("keeps Alt+Delete and Shift+Backspace for the shell", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    const input = vi.spyOn(controller.term, "input");

    select(controller, 7, 0, 5);
    expect(filter(controller, press("Delete", { altKey: true }))).toBe(true);

    select(controller, 7, 0, 5);
    expect(filter(controller, press("Backspace", { shiftKey: true }))).toBe(true);

    expect(input).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
  });
});

describe("paste and composition replace a selection", () => {
  it("sends the delete before the pasted text", async () => {
    const { controller, data } = fixture();
    // "$ echo hello": "hello" at [7, 12), cursor at 12.
    await write(controller, "$ echo hello");
    select(controller, 7, 0, 5);

    controller.writePaste("bye");
    await settleRestore();
    // The selection ended at the cursor, so there is nothing to walk back over.
    expect(data.mock.calls.map(([text]) => text)).toEqual([walkAndDelete(5, 5), "bye"]);
    expect(controller.term.hasSelection()).toBe(false);
  });

  it("walks back after a paste that replaced a mid-line selection", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);

    controller.writePaste("bye");
    await settleRestore();
    expect(data.mock.calls.map(([text]) => text)).toEqual([
      walkAndDelete(11, 5),
      "bye",
      "\x1b[C".repeat(6),
    ]);
  });

  it("pastes unchanged when the selection is not editable", async () => {
    const { controller, data } = fixture();
    await write(controller, "result line\r\n$ hi");
    select(controller, 0, 0, 6);

    controller.writePaste("bye");
    expect(data.mock.calls.map(([text]) => text)).toEqual(["bye"]);
  });

  it("keeps the selected command intact until an IME commits text", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea;
    expect(textarea).toBeTruthy();

    textarea!.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(data).not.toHaveBeenCalled();
    expect(controller.term.getSelection()).toBe("hello");
  });

  it("walks back after the IME's committed text, not before it", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea!;

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(data).not.toHaveBeenCalled();
    // What the browser does before compositionend: the committed text lands
    // in the textarea, and the IME patch reads it on the next task.
    textarea.value = "bye";
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(data.mock.calls.map(([text]) => text).join("")).toBe(
      walkAndDelete(11, 5) + "bye" + "\x1b[C".repeat(6),
    );
  });

  it("does not move or delete the selection while a Chinese composition takes time", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea!;
    vi.useFakeTimers();

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "nihao";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "nihao" }));
    vi.advanceTimersByTime(1000);
    expect(data).not.toHaveBeenCalled();
    expect(controller.term.getSelection()).toBe("hello");

    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "你好" }));
    vi.advanceTimersByTime(10);
    expect(data.mock.calls.map(([text]) => text).join("")).toBe(
      walkAndDelete(11, 5) + "你好" + "\x1b[C".repeat(6),
    );
    expect(controller.term.hasSelection()).toBe(false);
  });

  it("does not delete a selection when the user cancels the IME composition", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea!;
    vi.useFakeTimers();

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "nihao";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "nihao" }));
    vi.advanceTimersByTime(1000);
    textarea.value = "";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    vi.advanceTimersByTime(10);
    expect(data).not.toHaveBeenCalled();
    expect(controller.term.getSelection()).toBe("hello");
  });

  it("drops an old composition instead of writing it to a reconnected session", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea!;
    vi.useFakeTimers();

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    controller.setLocked(true);
    controller.setLocked(false);
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "你好" }));
    vi.advanceTimersByTime(1000);
    expect(data).not.toHaveBeenCalled();
  });

  it("does not delete a command line that changed while the IME was composing", async () => {
    const { controller, data } = fixture();
    await write(controller, "$ echo hello world");
    select(controller, 7, 0, 5);
    const textarea = controller.term.textarea!;

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    await write(controller, "\r$ echo other world");
    textarea.value = "好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "好" }));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(data.mock.calls.map(([text]) => text).join("")).toBe("好");
  });

  it("starts a composition unchanged when the selection is not editable", async () => {
    const { controller, data } = fixture();
    await write(controller, "result line\r\n$ hi");
    select(controller, 0, 0, 6);

    controller.term.textarea!.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(data).not.toHaveBeenCalled();
  });
});
