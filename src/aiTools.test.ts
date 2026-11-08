import { describe, expect, it } from "vitest";

import { aiSessionTool, isAiSessionCommand } from "./aiTools";

describe("recognising an agentic CLI session", () => {
  it.each([
    "claude",
    "codex",
    "codex --model gpt-5",
    "codex -m gpt-5",
    "pi",
    "pi --session abc",
    "omp",
    "omp launch",
    "omp --continue",
    'omp "Review the changes"',
    'omp launch "models"',
    'omp -- "models"',
    "omp --profile work launch",
    "omp --model gpt-x launch",
    "omp --no-title -- launch",
    "omp -- --mode text",
    "omp --model gpt-x -- config list",
    "./omp --model claude",
    "OMP_PROFILE=work omp",
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
    "omp -p 'review this'",
    "omp --print 'review this'",
    "omp --mode text 'review this'",
    "omp --mode=json",
    "omp --mode rpc",
    "omp --mode=rpc-ui",
    "omp --mode acp",
    "omp --profile work --mode rpc",
    "omp acp",
    "omp config list",
    "omp --model gpt-x config list",
    "omp --profile work models list",
    'omp --profile work "models"',
    'omp "models"',
    'omp "--print"',
    "omp --cwd /tmp bench",
    "omp --no-title stats",
    'omp --model "models" --no-title config list',
    "omp models list",
    "omp bench",
    "omp git",
    "omp stats",
    "omp --export session.json",
    "omp --profile work --alias work-agent",
    "omp --model gpt-x --export session.json",
    "opencode run 'review'",
    "aider -m 'fix this'",
  ])("rejects %s", (command) => {
    expect(isAiSessionCommand(command)).toBe(false);
  });

  it("attributes the OMP interactive CLI to its own session", () => {
    expect(aiSessionTool("omp --restore latest")).toBe("omp");
    expect(aiSessionTool("cd ~/repo && omp launch")).toBe("omp");
  });
});
