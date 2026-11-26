import { createElement as h, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { useStore, type Tab } from "../store";
import { disposeController, getController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames, wait } from "./browserHarness";
import "../styles.css";

/**
 * "Copy last command" / "copy last command output", end to end: real App, real
 * xterm, real keystrokes, recorded IPC. The fixture plays the shell's part
 * (echoing what was typed and printing a prompt after the output), because the
 * native host is a stub — everything on the app's side is real.
 *
 * Boundary: Chromium over a controlled IPC stub; no native PTY.
 */

const CLIPBOARD: string[] = [];
const INPUT: string[] = [];
let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string, args: Record<string, unknown>) {
    if (command === "write_clipboard_text") CLIPBOARD.push(String(args.text));
    if (command === "write_session") INPUT.push(String(args.data));
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();
const ID = "copy-session";

const tab = (): Tab => ({
  info: {
    id: ID,
    name: "copy",
    kind: "local",
    protocol: "local",
    profileId: null,
    address: "local",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-copy", name: "copy", kind: "local" },
  number: 1,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const until = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await wait(50);
};

const write = (text: string) =>
  new Promise<void>((resolve) => getController(ID)!.term.write(text, () => resolve()));

const runPaletteCommand = async (query: string) => {
  await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
  await twoFrames();
  const field = document.querySelector<HTMLInputElement>(".command-palette-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, query);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await twoFrames();
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
  );
  await twoFrames();
};

const mountSession = async () => {
  await page.viewport(1280, 800);
  useStore.getState().setLanguage("en");
  useStore.getState().setShortcuts(defaultShortcuts());
  useStore.setState({
    ...initial,
    tabs: [tab()],
    activeId: ID,
    panes: [{ id: "root", activeTabId: ID }],
    layout: { kind: "leaf", paneId: "root" },
    activePaneId: "root",
    language: "en",
    gpuRenderer: false,
    panels: { sessions: false, filer: false, sender: false },
    status: "",
  });
  mount(h(StrictMode, null, h(App)));
  await expect.poll(() => getController(ID)?.term.element?.isConnected).toBe(true);
  await twoFrames();
  const controller = getController(ID)!;
  controller.focus();
  await write("$ ");
  await twoFrames();
};

/** Types a command (the shell echoes it) and presses Enter, as a user would. */
const runCommand = async (command: string) => {
  const controller = getController(ID)!;
  controller.focus();
  await userEvent.keyboard(command);
  await write(command);
  await userEvent.keyboard("{Enter}");
  await twoFrames();
};

describe("copy the last command", () => {
  beforeEach(() => {
    // Linux uses the Web Clipboard API, Windows and macOS use native IPC.
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      CLIPBOARD.push(text);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await browserAfterEach();
    disposeController(ID);
    useStore.setState(initial, true);
    CLIPBOARD.length = 0;
  });

  it("copies the output and then the command line of the finished command", async () => {
    await mountSession();
    await runCommand("echo hi");
    await write("\r\nhi\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "echo hi");
    expect(getController(ID)!.lastCommandText()).toBe("echo hi");

    await runPaletteCommand("Copy Last Command Output");
    expect(
      CLIPBOARD[CLIPBOARD.length - 1],
      "the output, without the echoed command or the prompt",
    ).toBe("hi");

    await runPaletteCommand("Copy Last Command Line");
    expect(CLIPBOARD[CLIPBOARD.length - 1]).toBe("echo hi");
    expect(useStore.getState().status).toBe("Copied to the clipboard");
  });

  it("follows the newest command, and trims the blank rows a prompt leaves", async () => {
    await mountSession();
    await runCommand("pwd");
    await write("\r\n/tmp/work\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "pwd");
    await runCommand("ls");
    await write("\r\nfile-a\r\nfile-b\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "ls");

    await runPaletteCommand("Copy Last Command Output");
    // Diagnostics on failure: the status bar says which half refused.
    expect({ clipboard: CLIPBOARD, status: useStore.getState().status }, "after the second copy") // Terminal rows are joined with CRLF, as they are on the wire and in other
      // terminal clients' "copy output".
      .toEqual({ clipboard: ["file-a\r\nfile-b"], status: "Copied to the clipboard" });
  });

  it("refuses, with a status message, before any command has finished", async () => {
    await mountSession();
    await runPaletteCommand("Copy Last Command Output");
    expect(CLIPBOARD).toEqual([]);
    expect(useStore.getState().status).toBe("No finished command to copy yet");
    expect(
      document.querySelectorAll(".gutter-row.is-command").length,
      "no command, no timeline marks",
    ).toBe(0);
  });
  it("walks between finished commands with the real chord", async () => {
    await mountSession();
    // Filler gives the walk somewhere to go: a command has to leave the
    // visible page before a jump can prove it scrolled back to it.
    const filler = (count: number, tag: string) =>
      Array.from({ length: count }, (_, index) => tag + "-" + index + "\r\n").join("");
    await write(filler(40, "boot"));
    await write("$ ");
    await runCommand("echo one");
    await write("\r\none\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "echo one");
    await write(filler(40, "noise"));
    await write("$ ");
    await runCommand("echo two");
    await write("\r\ntwo\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "echo two");

    const controller = getController(ID)!;
    const rowOf = (label: string) => {
      const buffer = controller.term.buffer.active;
      for (let row = 0; row < buffer.length; row += 1) {
        if (buffer.getLine(row)?.translateToString(true) === label) return row;
      }
      return -1;
    };
    const one = rowOf("$ echo one");
    const two = rowOf("$ echo two");
    expect(one, "the first command line").toBeGreaterThanOrEqual(0);
    expect(two, "the second command line is below the first").toBeGreaterThan(one);
    const rows = controller.term.rows;
    /** Gutter line numbers carrying the command mark (1-based absolute rows). */
    const markedLines = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".gutter-row.is-command")).map((row) =>
        Number(row.querySelector(".gutter-line")?.textContent),
      );
    /** The buffer row the jump marks, read from the tint's position. */
    const landingRow = () => {
      const mark = document.querySelector<HTMLElement>(".command-jump");
      const screen = controller.term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!mark || !screen) return -1;
      const box = screen.getBoundingClientRect();
      const cell = box.height / rows;
      return (
        controller.term.buffer.active.viewportY +
        Math.round((mark.getBoundingClientRect().top - box.top) / cell)
      );
    };

    // The chord belongs to the app, not the shell; the landing is shown by
    // the tint, which is also what tells the test which command it hit.
    await userEvent.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
    await twoFrames();
    expect(landingRow(), "the first jump lands on the newest command").toBe(two);
    expect(markedLines(), "the gutter marks the command it landed on").toContain(two + 1);

    await userEvent.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
    await twoFrames();
    expect(landingRow(), "the second jump lands on the older one").toBe(one);
    expect(markedLines(), "and its own line is marked").toContain(one + 1);
    const top = controller.term.buffer.active.viewportY;
    expect(one, "and it is brought into view").toBeGreaterThanOrEqual(top);
    expect(one).toBeLessThan(top + rows);

    await userEvent.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
    expect(useStore.getState().status, "nothing older, and the bar says so").toBe(
      "No command in that direction",
    );

    await userEvent.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");
    await twoFrames();
    expect(landingRow(), "and down again").toBe(two);
  });

  it("copies the last output with the chord, and the chord never reaches the shell", async () => {
    await mountSession();
    await runCommand("echo one");
    await write("\r\none\r\n$ ");
    await until(() => getController(ID)!.lastCommandText() === "echo one");
    INPUT.length = 0;
    CLIPBOARD.length = 0;

    // Ctrl+Shift+O: the app's chord, not a control byte for the shell.
    await userEvent.keyboard("{Control>}{Shift>}O{/Shift}{/Control}");
    await twoFrames();
    await until(() => CLIPBOARD.length > 0);
    expect(CLIPBOARD[CLIPBOARD.length - 1]).toBe("one");
    expect(useStore.getState().status).toBe("Copied to the clipboard");
    expect(INPUT, "the shell saw no input for the chord").toEqual([]);
  });
});
