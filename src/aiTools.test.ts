import { describe, expect, it } from "vitest";

import { isAiSessionCommand } from "./aiTools";

describe("recognising an agentic CLI session", () => {
  it.each([
    "claude",
    "codex",
    "codex --model gpt-5",
    "codex -m gpt-5",
    "pi",
    "pi --session abc",
    'opencode --prompt "review this project"',
    'opencode mini -m provider/model --prompt "review"',
    '& "C:/Program Files/agents/pi.cmd"',
    "claude --resume",
    'claude "fix the failing test"',
    "gemini",
    "aider",
    "cursor-agent",
    "/usr/local/bin/claude",
    "~/.claude/local/claude",
    "./codex",
    "claude.cmd",
    "ANTHROPIC_API_KEY=x claude",
    "sudo -E claude",
    "npx @anthropic-ai/claude-code",
    "pnpm dlx opencode",
    "cd ~/work/repo && claude",
  ])("accepts %s", (command) => {
    expect(isAiSessionCommand(command)).toBe(true);
  });

  it.each([
    "",
    "ls -la",
    "top",
    "git commit -m claude",
    "vim claude.ts",
    "claude -p 'summarise this'",
    "claude --print hello",
    "codex exec 'run the tests'",
    "claude mcp list",
    "claude --version",
    "cat notes.md | claude",
    "npx create-react-app claude",
    "pi -p 'review this'",
    "pi --mode rpc",
    "pi --mode=json",
    "opencode run 'review'",
    "aider -m 'fix this'",
  ])("rejects %s", (command) => {
    expect(isAiSessionCommand(command)).toBe(false);
  });
});
