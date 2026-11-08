/**
 * Recognizes the agentic CLIs — Claude Code, Codex, Gemini CLI and the like —
 * that hold the terminal for a whole session. Their command only returns when
 * the user quits, so tracking it like an ordinary one would leave the tab
 * "command running" for as long as the tool is open, which says nothing. A
 * recognized session switches terminal activity to the assistant's turns
 * instead: busy while it works, finished when it hands the terminal back.
 */

/** Binary names, as they are typed. Basenames, so a full path also matches. */
const AI_CLIS = new Set([
  "claude",
  "codex",
  "gemini",
  "aider",
  "cursor-agent",
  "copilot",
  "amp",
  "opencode",
  "omp",
  "pi",
  "pi-coding-agent",
  "crush",
  "goose",
  "qwen",
  "droid",
  "openhands",
  "grok",
  // As spelled on npm, for `npx @anthropic-ai/claude-code`.
  "claude-code",
  "gemini-cli",
]);

/** Words that only stand in front of the real command. */
const PREFIXES = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "time",
  "nohup",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
]);

/** Package runners spelled as two words: `pnpm dlx claude`. */
const RUNNERS: Record<string, string[]> = {
  npm: ["exec"],
  pnpm: ["dlx", "exec"],
  yarn: ["dlx"],
  bun: ["x"],
  uv: ["run"],
  deno: ["run"],
};

/**
 * Flags that turn these tools into a one-shot run with no session to follow:
 * `claude -p "..."`, `aider --message ...`, `codex --version`.
 */
const ONE_SHOT_FLAGS = new Set(["-h", "--help", "-v", "-V", "--version"]);

/** First-argument subcommands that do not open a session. */
const ONE_SHOT_SUBCOMMANDS = new Set([
  "exec",
  "run",
  "mcp",
  "update",
  "upgrade",
  "install",
  "uninstall",
  "doctor",
  "config",
  "login",
  "logout",
  "auth",
  "help",
  "version",
  "completion",
  "setup-token",
  "migrate-installer",
]);

/** OMP subcommands other than `launch` do not start a coding-agent turn.
 * https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md
 */
const OMP_OTHER_SUBCOMMANDS = new Set([
  "acp",
  "auth-broker",
  "auth-gateway",
  "agents",
  "bench",
  "browser-relay",
  "cleanse",
  "collab",
  "clip",
  "commit",
  "completions",
  "compress",
  "config",
  "dry-balance",
  "find",
  "gc",
  "grep",
  "gallery",
  "git",
  "grievances",
  "if-bench",
  "images",
  "img",
  "install",
  "join",
  "login",
  "models",
  "plugin",
  "plugins",
  "play",
  "predict",
  "ps",
  "say",
  "share",
  "shell",
  "read",
  "render",
  "setup",
  "skill",
  "skills",
  "ssh",
  "stats",
  "stream",
  "update",
  "usage",
  "tiny-models",
  "token",
  "toks",
  "ttsr",
  "worktree",
  "wt",
  "search",
  "q",
  "web-search",
  "__complete",
]);

/** Launch options whose next argv token is a value, not an OMP subcommand. */
const OMP_VALUE_FLAGS = new Set([
  "--cwd",
  "--add-dir",
  "--profile",
  "--config",
  "--session-dir",
  "--resume",
  "-r",
  "--session",
  "--restore",
  "--fork",
  "--model",
  "--smol",
  "--slow",
  "--plan",
  "--models",
  "--provider",
  "--api-key",
  "--provider-session-id",
  "--prompt-cache-key",
  "--service-tier",
  "--thinking",
  "--prewalk-into",
  "--plan-yolo-into",
  "--goal",
  "--tools",
  "--approval-mode",
  "--max-time",
  "--motion",
  "--spinner-interval",
  "--max-fps",
  "--warn-cost",
  "--max-cost",
  "--extension",
  "-e",
  "--hook",
  "--trusted-extension",
  "--plugin-dir",
  "--skills",
  "--system-prompt",
  "--system-prompt-template",
  "--append-system-prompt",
]);

/** `VAR=value` assignments in front of a command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Last path segment, without a Windows executable suffix. */
function binaryName(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * True when the command line starts an interactive session with one of the
 * tools above. `cd repo && claude` counts; a pipeline does not, since a tool
 * reading from a pipe is not driving the terminal.
 */
export function isAiSessionCommand(command: string): boolean {
  return aiSessionTool(command) !== null;
}

/** Recognizes syntax only; never executes a command or expands shell variables. */
export function aiSessionTool(command: string): string | null {
  const segments = command.match(/(?:[^"';&|]|"[^"]*"|'[^']*')+|&&|\|\||[;|]/g) ?? [];
  for (let at = 0; at < segments.length; at++) {
    const segment = segments[at];
    if (segment === "|" || segments[at - 1] === "|" || segments[at + 1] === "|") continue;
    const tool = startsAiSession(segment);
    if (tool) return tool;
  }
  return null;
}

function startsAiSession(segment: string): string | null {
  const raw = segment.trim().match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
  const tokens = raw.map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  let index = 0;
  let prefixed = false;
  while (index < tokens.length) {
    const token = tokens[index];
    // `sudo -E claude`, `npx -y ...`: options belong to the prefix in front.
    if (ASSIGNMENT.test(token) || (prefixed && token.startsWith("-"))) {
      index += 1;
      continue;
    }
    const name = binaryName(token);
    if (PREFIXES.has(name)) {
      index += 1;
      prefixed = true;
      continue;
    }
    if (RUNNERS[name]?.includes(tokens[index + 1] ?? "")) {
      index += 2;
      prefixed = true;
      continue;
    }
    break;
  }

  const tool = binaryName(tokens[index] ?? "");
  if (!AI_CLIS.has(tool)) return null;

  const args = tokens.slice(index + 1);
  if (tool === "omp") return isOmpSession(args) ? tool : null;
  if (args.some((arg) => ONE_SHOT_FLAGS.has(arg))) return null;
  // Flags belong to tools: -m is a model in Codex/OpenCode and a message in
  // aider. OpenCode --prompt opens its TUI; Pi --mode rpc does not.
  const flags =
    tool === "aider"
      ? ["-m", "--message"]
      : tool === "opencode"
        ? []
        : tool === "codex"
          ? []
          : ["-p", "--print", "--prompt"];
  if (args.some((arg) => flags.includes(arg.split("=", 1)[0]))) return null;
  if (tool === "pi" || tool === "pi-coding-agent") {
    const modeAt = args.indexOf("--mode");
    const mode =
      args.find((arg) => arg.startsWith("--mode="))?.slice(7) ??
      (modeAt >= 0 ? args[modeAt + 1] : undefined);
    if (mode && mode !== "interactive") return null;
  }
  // Only the first positional word is a subcommand; a quoted opening prompt
  // (`codex "run the tests"`) keeps its quote and never looks like one.
  const first = args[0];
  return first !== undefined &&
    !raw[index + 1]?.startsWith('"') &&
    !raw[index + 1]?.startsWith("'") &&
    ONE_SHOT_SUBCOMMANDS.has(first)
    ? null
    : tool;
}

/** OMP permits launch flags before a subcommand, e.g. `omp --profile dev stats`.
 * Quotes do not change argv semantics: `omp "models"` is still a subcommand.
 * `--` ends flag/subcommand parsing so following words are literal prompts.
 * Explicit `--mode text` is headless unlike the default.
 */
function isOmpSession(args: string[]): boolean {
  let firstPositional: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      const flag = arg.split("=", 1)[0];
      if (
        ONE_SHOT_FLAGS.has(flag) ||
        flag === "-p" ||
        flag === "--print" ||
        flag === "--mode" ||
        flag === "--export" ||
        flag === "--alias"
      ) {
        return false;
      }
      if (OMP_VALUE_FLAGS.has(flag) && flag === arg) i += 1;
      continue;
    }
    if (firstPositional === null) firstPositional = arg;
  }
  return !firstPositional || !OMP_OTHER_SUBCOMMANDS.has(firstPositional);
}
