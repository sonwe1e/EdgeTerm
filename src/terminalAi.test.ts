import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));

import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
const encoder = new TextEncoder();
const PROMPT = "alice@server:~/repo$ ";

function createController(events: string[], onData = (_data: string) => {}) {
  const controller = new TerminalController(
    "ai-test",
    {
      onData,
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState: (state, kind) => events.push(`${state}:${kind}`),
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  controllers.push(controller);
  return controller;
}

/** Writes and lets xterm's write buffer drain under the fake clock. */
async function write(controller: TerminalController, text: string) {
  const parsed = new Promise<void>((resolve) => controller.term.write(text, resolve));
  await vi.advanceTimersByTimeAsync(0);
  await parsed;
}

/** Output from the tool itself, on the byte path the session uses. */
function output(controller: TerminalController, text: string) {
  controller.write(encoder.encode(text));
}

/** Types a command at the prompt already on screen and submits it. */
async function submit(controller: TerminalController, command: string) {
  controller.term.input(command, true);
  await write(controller, command);
  controller.term.input("\r", true);
  await write(controller, "\r\n");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("agentic CLI sessions", () => {
  it("accepts OpenCode's idle report when Enter beats the SSH command echo", async () => {
    const events: string[] = [];
    const sent: string[] = [];
    const controller = createController(events, (data) => sent.push(data));
    await write(controller, PROMPT);
    controller.term.input("opencode", true);
    controller.term.input("\r", true);
    expect(events).toEqual(["running:command"]);
    await write(controller, "opencode\r\n\x1b[?1049h");
    sent.length = 0;
    await write(controller, "\x1b]7501;?\x1b\\");
    expect(sent).toEqual(["\x1b]7501;?\x1b\\"]);
    output(controller, "\x1b]7501;state=idle:app=opencode\x1b\\");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.agentDiagnostics().tool).toBe("opencode");
    expect(events[events.length - 1]).toBe("idle:ai");
    controller.term.input("draft", true);
    for (let i = 0; i < 5; i++) {
      output(controller, `\x1b[HOpenCode ready ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(events[events.length - 1]).toBe("idle:ai");
  });

  it("recognizes an OpenCode status even without observing its launch command", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b[?1049h\x1b]7501;state=working:app=opencode\x07");
    expect(controller.agentDiagnostics().tool).toBe("opencode");
    expect(events[events.length - 1]).toBe("running:ai");
    await write(controller, "\x1b]7501;state=idle:app=opencode\x07");
    expect(events[events.length - 1]).toBe("complete:ai");
  });

  it("answers capability queries before a command has been identified", async () => {
    const events: string[] = [];
    const sent: string[] = [];
    const controller = createController(events, (data) => sent.push(data));
    await write(controller, "\x1b]7501;?\x1b\\");
    expect(sent).toEqual(["\x1b]7501;?\x1b\\"]);
    expect(events).toEqual([]);
  });

  it("releases a status-discovered OpenCode session when its shell prompt returns", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, "\x1b[?1049h\x1b]7501;state=idle:app=opencode\x07");
    // OpenCode's Ctrl+C exit can restore the screen without a root clear.
    await write(controller, `\x1b[?1049l${PROMPT}`);
    expect(controller.agentDiagnostics().tool).toBeNull();
    expect(controller.agentDiagnostics().commandRunning).toBe(false);
    events.length = 0;
    await submit(controller, "sleep 3");
    expect(events).toEqual(["running:command"]);
    await write(controller, PROMPT);
    expect(events[events.length - 1]).toBe("complete:command");
  });

  it("ignores malformed identities and keeps generic program reports as command activity", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "sleep 3");
    await write(controller, "\x1b]7501;state=idle:app=opencode:id=bad//id\x07");
    expect(events).toEqual(["running:command"]);
    expect(controller.agentDiagnostics().tool).toBeNull();
    await write(controller, "\x1b]7501;state=idle:app=compiler\x07");
    expect(events[events.length - 1]).toBe("idle:command");
    await write(controller, "\x1b]7501;state=working:app=compiler\x07");
    expect(events[events.length - 1]).toBe("running:command");
    await write(controller, "\x1bc");
    expect(events[events.length - 1]).toBe("idle:command");
  });

  it("does not report the session itself as a running command", async () => {
    const events: string[] = [];
    const controller = createController(events);

    await write(controller, PROMPT);
    await submit(controller, "claude");
    expect(events).toEqual(["idle:ai"]);

    // Its startup banner is not a turn: nothing was asked of it yet.
    output(controller, "Welcome to Claude Code\r\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["idle:ai"]);
  });

  it("runs from the prompt sent to it until it goes quiet", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");
    events.length = 0;

    controller.term.input("fix the failing test", true);
    controller.term.input("\r", true);
    expect(events).toEqual(["running:ai"]);

    // A working assistant repaints its spinner the whole time, tool calls
    // included; that keeps the turn open however long the work takes.
    for (let tick = 0; tick < 8; tick += 1) {
      await vi.advanceTimersByTimeAsync(1500);
      output(controller, "\r\x1b[K* Thinking... (esc to interrupt)");
    }
    expect(events).toEqual(["running:ai"]);

    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai"]);
  });

  it("does not open a turn for the terminal's own replies", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");
    events.length = 0;

    // What one of these tools asks the terminal on startup: which device it
    // is, where the cursor sits, and to be told about focus — the last of
    // which reports back on every tab switch. xterm answers through the
    // same channel as the keyboard, and none of it is the user typing.
    await write(controller, "\x1b[c\x1b[6n\x1b[?1004h");
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);
  });

  it("opens a new turn for every answer the user gives", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "codex");
    events.length = 0;

    controller.term.input("run the tests", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai"]);

    // Answering a permission question resumes the assistant, with or
    // without an Enter of its own.
    controller.term.input("y", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai", "running:ai", "complete:ai"]);
  });

  it("returns to command tracking once the tool exits", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "claude");

    // `/exit` hands the terminal back to the shell.
    await write(controller, PROMPT);
    expect(events).toEqual(["idle:ai", "complete:ai"]);

    await submit(controller, "ls -la");
    await write(controller, `file-a  file-b\r\n${PROMPT}`);
    expect(events).toEqual(["idle:ai", "complete:ai", "running:command", "complete:command"]);
  });

  it("tracks an ordinary command the usual way", async () => {
    const events: string[] = [];
    const controller = createController(events);

    await write(controller, PROMPT);
    await submit(controller, "npm test");
    expect(events).toEqual(["running:command"]);
    // Keystrokes and output alone never end an ordinary command.
    controller.term.input("x", true);
    output(controller, "passing\r\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["running:command"]);

    await write(controller, PROMPT);
    expect(events).toEqual(["running:command", "complete:command"]);
  });

  it("stops OpenCode activity on its idle report despite continuous redraws", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    await write(controller, "\x1b[?1049h");
    events.length = 0;

    controller.term.input("review this\r", true);
    expect(events).toEqual(["running:ai"]);
    // Real session byte path, including an OSC split between transport chunks.
    output(controller, "\x1b]7501;state=id");
    output(controller, "le:app=opencode\x1b\\");
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["running:ai", "complete:ai"]);

    events.length = 0;
    controller.term.input("draft not submitted", true);
    for (let tick = 0; tick < 8; tick += 1) {
      output(controller, `\x1b[HOpenCode\r\nReady ${tick}\x1b[?25h`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(events).toEqual([]);
  });

  it("keeps an explicitly working agent active through silent tools", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    events.length = 0;

    // A resumed session may already be working without a local keystroke.
    output(controller, "\x1b]7501;state=working:app=opencode\x07");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toEqual(["running:ai"]);

    output(controller, "\x1b]7501;state=idle:app=opencode\x07");
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["running:ai", "complete:ai"]);
  });

  it("marks a blocked agent for review and waits for its explicit resume", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    events.length = 0;
    await write(controller, "\x1b]7501;state=working:app=opencode\x07");
    await write(controller, "\x1b]7501;state=blocked:kind=permission:app=opencode\x07");
    expect(events).toEqual(["running:ai", "complete:ai"]);

    controller.term.input("y", true);
    output(controller, "\rAllow this tool?\x1b[K");
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual(["running:ai", "complete:ai"]);
    await write(controller, "\x1b]7501;state=working:app=opencode\x07");
    expect(events[events.length - 1]).toBe("running:ai");
  });

  it("does not let a cleared child task erase another running task", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    await write(controller, "\x1b]7501;state=idle:app=opencode\x07");
    events.length = 0;
    await write(controller, "\x1b]7501;state=working:id=session/one\x07");
    await write(controller, "\x1b]7501;state=working:id=session/two\x07");
    await write(controller, "\x1b]7501;state=clear:id=session/one\x07");
    expect(events).toEqual(["running:ai"]);
    await write(controller, "\x1b]7501;state=clear:id=session\x07");
    expect(events[events.length - 1]).toBe("complete:ai");
  });

  it("answers status queries without treating the reply as user input", async () => {
    const events: string[] = [];
    const sent: string[] = [];
    const controller = createController(events, (data) => sent.push(data));
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    events.length = 0;
    sent.length = 0;
    await write(controller, "\x1b]7501;?\x1b\\");
    expect(sent).toEqual(["\x1b]7501;?\x1b\\"]);
    expect(events).toEqual([]);
    // Negotiation alone does not disable activity detection on older tools.
    controller.term.input("hello", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["running:ai", "complete:ai"]);
  });

  it("drops explicit activity tracking when the agent exits or reconnects", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    await write(controller, "\x1b]7501;state=working:app=opencode\x07");
    await write(controller, PROMPT);
    events.length = 0;
    await submit(controller, "claude");
    controller.term.input("hello", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["idle:ai", "running:ai", "complete:ai"]);

    await write(controller, "\x1b]7501;state=working\x07");
    controller.setLocked(true);
    await write(controller, "\x1b]7501;state=working\x07");
    controller.setLocked(false);
    await write(controller, `\r\n${PROMPT}`);
    events.length = 0;
    await submit(controller, "opencode");
    controller.term.input("hello", true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).toEqual(["idle:ai", "running:ai", "complete:ai"]);
  });

  it("ignores invalid status and clears reported activity on a full terminal reset", async () => {
    const events: string[] = [];
    const controller = createController(events);
    await write(controller, PROMPT);
    await submit(controller, "opencode");
    await write(controller, "\x1b]7501;state=working\x07");
    events.length = 0;
    await write(controller, "\x1b]7501;state=idle:id=bad//id\x07");
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);
    await write(controller, "\x1bc");
    expect(events).toEqual(["idle:ai"]);
  });
});
