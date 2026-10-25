import type * as Wire from "../bindings";
import type { MessageKey } from "../i18n";
import type {
  Experiment,
  RunBinding,
  RunCodeState,
  RunRecord,
  RunSnapshot,
  RunStatus,
  ServerIdentity,
  ServerRef,
  Workspace,
  WorkspaceCommand,
  WorkspaceData,
} from "./types";

const commandKinds: readonly Wire.WorkspaceCommandKind[] = [
  "train",
  "validate",
  "infer",
  "shell",
  "other",
];

/** Defaults for a record the backend filled in, or an older file. */
export function normalizeServer(raw?: Partial<Wire.ServerRef> | null): ServerRef {
  return {
    profileId: raw?.profileId ?? "",
    name: raw?.name ?? "",
    host: raw?.host ?? "",
    port: raw?.port || 22,
    username: raw?.username ?? "",
  };
}

export function normalizeCommand(raw: Wire.WorkspaceCommand): WorkspaceCommand {
  const kind = commandKinds.includes(raw.kind as Wire.WorkspaceCommandKind)
    ? (raw.kind as Wire.WorkspaceCommandKind)
    : "other";
  return {
    id: raw.id ?? "",
    label: raw.label ?? "",
    command: raw.command ?? "",
    kind,
  };
}

export function normalizeWorkspace(raw: Wire.Workspace): Workspace {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    server: normalizeServer(raw.server),
    root: raw.root ?? "",
    env: raw.env ?? "",
    commands: (raw.commands ?? []).map(normalizeCommand),
    runRoot: raw.runRoot ?? "",
    baselineExperimentId: raw.baselineExperimentId ?? null,
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
  };
}

export function normalizeExperiment(raw: Wire.Experiment): Experiment {
  return {
    id: raw.id ?? "",
    workspaceId: raw.workspaceId ?? "",
    name: raw.name ?? "",
    kind: raw.kind === "baseline" ? "baseline" : "variant",
    baselineId: raw.baselineId ?? null,
    root: raw.root || null,
    branch: raw.branch || null,
    notes: raw.notes ?? "",
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
  };
}

export function normalizeCode(raw?: Wire.RunCodeState | null): RunCodeState {
  return {
    branch: raw?.branch ?? "",
    commit: raw?.commit ?? "",
    dirty: raw?.dirty ?? false,
    dirtyFiles: raw?.dirtyFiles ?? [],
    diffSha256: raw?.diffSha256 ?? "",
    diffBytes: raw?.diffBytes ?? 0,
    diffTruncated: raw?.diffTruncated ?? false,
    isRepository: raw?.isRepository ?? false,
  };
}

export function normalizeSnapshot(raw?: Wire.RunSnapshot | null): RunSnapshot {
  return {
    mode: raw?.mode === "code" ? "code" : "none",
    path: raw?.path ?? "",
    files: raw?.files ?? 0,
    bytes: raw?.bytes ?? 0,
    skipped: raw?.skipped ?? 0,
    verified: raw?.verified ?? false,
    note: raw?.note ?? "",
  };
}

/** Older records predate the binding; they describe a workspace run. */
export function normalizeBinding(raw?: Wire.RunBinding | null): RunBinding {
  return {
    execution: raw?.execution === "isolated" ? "isolated" : "workspace",
    executedFrom: raw?.executedFrom ?? "",
    workspaceRoot: raw?.workspaceRoot ?? "",
    isolated: raw?.isolated ?? false,
    snapshotVerified: raw?.snapshotVerified ?? false,
    unsynced: raw?.unsynced ?? [],
    links: raw?.links ?? [],
    note: raw?.note ?? "",
  };
}

export function normalizeRun(raw: Wire.RunRecord): RunRecord {
  return {
    id: raw.id ?? "",
    workspaceId: raw.workspaceId ?? "",
    experimentId: raw.experimentId ?? "",
    server: normalizeServer(raw.server),
    root: raw.root ?? "",
    command: raw.command ?? "",
    env: raw.env ?? "",
    gpu: raw.gpu ?? "",
    scheduler: raw.scheduler ?? null,
    submitOnly: raw.submitOnly ?? false,
    mode: raw.mode === "detached" ? "detached" : raw.mode === "terminal" ? "terminal" : "tmux",
    status: (raw.status ?? "unknown") as RunStatus,
    startedAt: raw.startedAt ?? 0,
    endedAt: raw.endedAt ?? null,
    exitCode: raw.exitCode ?? null,
    code: normalizeCode(raw.code),
    snapshot: normalizeSnapshot(raw.snapshot),
    binding: normalizeBinding(raw.binding),
    runDir: raw.runDir ?? "",
    logPath: raw.logPath ?? "",
    taskName: raw.taskName ?? "",
    resumedFrom: raw.resumedFrom ?? null,
    note: raw.note ?? "",
    lastSeenAt: raw.lastSeenAt ?? 0,
  };
}

export function normalizeData(raw: Wire.WorkspaceData | null | undefined): WorkspaceData {
  return {
    workspaces: (raw?.workspaces ?? []).map(normalizeWorkspace),
    experiments: (raw?.experiments ?? []).map(normalizeExperiment),
    runs: (raw?.runs ?? []).map(normalizeRun),
  };
}

/** `user@host:port`, the identity a tab title cannot provide. */
export function serverKey(server: ServerRef): string {
  return `${server.username.trim()}@${server.host.trim()}:${server.port || 22}`;
}

export function serverLabel(server: ServerRef): string {
  const key = serverKey(server);
  return server.name && server.name !== server.host ? `${server.name} · ${key}` : key;
}

export function joinRemote(root: string, relative: string): string {
  if (!root) return relative;
  if (relative.startsWith("/")) return relative;
  return `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

export function relativePath(root: string, absolute: string): string {
  const normalizedRoot = `${root.replace(/\/+$/, "")}/`;
  return absolute.startsWith(normalizedRoot) ? absolute.slice(normalizedRoot.length) : absolute;
}

export function experimentsOf(data: WorkspaceData, workspaceId: string): Experiment[] {
  const order = { baseline: 0, variant: 1 };
  return data.experiments
    .filter((experiment) => experiment.workspaceId === workspaceId)
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] || a.createdAt - b.createdAt || a.name.localeCompare(b.name),
    );
}

export function baselineOf(data: WorkspaceData, workspace: Workspace): Experiment | null {
  return (
    data.experiments.find(
      (experiment) =>
        experiment.workspaceId === workspace.id &&
        (experiment.id === workspace.baselineExperimentId || experiment.kind === "baseline"),
    ) ?? null
  );
}

export function experimentRoot(workspace: Workspace, experiment: Experiment | null): string {
  return experiment?.root?.trim() || workspace.root;
}

export function runsOf(
  data: WorkspaceData,
  workspaceId: string,
  experimentId?: string | null,
): RunRecord[] {
  return data.runs
    .filter(
      (run) =>
        run.workspaceId === workspaceId && (!experimentId || run.experimentId === experimentId),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function activeRuns(data: WorkspaceData): RunRecord[] {
  return data.runs.filter((run) => isRunLive(run.status));
}

export function isRunLive(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "submitted";
}

/** The launch identity a run record carries, short enough for a list row. */
export function runCodeId(run: RunRecord): string {
  if (!run.code.isRepository) return "no repo";
  const commit = run.code.commit ? run.code.commit.slice(0, 8) : "uncommitted";
  return run.code.dirty ? `${commit}+dirty` : commit;
}

export function runStatusKey(status: RunStatus): MessageKey {
  switch (status) {
    case "starting":
      return "wb.statusStarting";
    case "running":
      return "wb.statusRunning";
    case "submitted":
      return "wb.statusSubmitted";
    case "finished":
      return "wb.statusFinished";
    case "failed":
      return "wb.statusFailed";
    case "stopped":
      return "wb.statusStopped";
    case "lost":
      return "wb.statusLost";
    default:
      return "wb.statusUnknown";
  }
}

export function formatDuration(startedAt: number, endedAt: number | null, now: number): string {
  if (!startedAt) return "—";
  const total = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatClock(at: number): string {
  if (!at) return "—";
  return new Date(at).toLocaleTimeString();
}

/** One sample per server, however many projects share it. */
export function hostIdentities(workspaces: Workspace[]): ServerIdentity[] {
  const byKey = new Map<string, ServerIdentity>();
  for (const workspace of workspaces) {
    const key = serverKey(workspace.server);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.workspaceIds.includes(workspace.id)) {
        existing.workspaceIds.push(workspace.id);
      }
    } else {
      byKey.set(key, {
        key,
        server: workspace.server,
        workspaceIds: [workspace.id],
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Sampling cadence: quieter while the window is in the background. */
export function samplingIntervalMs(visible: boolean): number {
  return visible ? 5000 : 30000;
}

export function staleAfterMs(visible: boolean): number {
  return visible ? 20000 : 90000;
}

/**
 * A subsequence match for the quick-open box: every character of the query
 * appears in order in the path. Earlier and adjacent matches score higher,
 * and the basename is preferred over a directory of the same length.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = path.toLowerCase();
  let index = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found < 0) return null;
    score += found === previous + 1 ? 6 : 1;
    if (found < path.lastIndexOf("/") + 1) score += 0;
    else score += 2;
    previous = found;
    index = found + 1;
  }
  // Shorter paths win at equal subsequence quality.
  return score - Math.min(40, Math.floor(path.length / 8));
}

export function fuzzyFilter(query: string, files: string[], limit = 200): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** A run's record before the backend fills in code, paths and status. */
export function draftRun(input: {
  id: string;
  workspace: Workspace;
  experiment: Experiment;
  root: string;
  command: string;
  env: string;
  gpu: string;
  resumedFrom?: string | null;
}): RunRecord {
  return {
    id: input.id,
    workspaceId: input.workspace.id,
    experimentId: input.experiment.id,
    server: input.workspace.server,
    root: input.root,
    command: input.command,
    env: input.env,
    gpu: input.gpu,
    scheduler: null,
    submitOnly: false,
    mode: "tmux",
    status: "starting",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    code: normalizeCode(null),
    snapshot: normalizeSnapshot(null),
    binding: normalizeBinding(null),
    runDir: "",
    logPath: "",
    taskName: "",
    resumedFrom: input.resumedFrom ?? null,
    note: "",
    lastSeenAt: Date.now(),
  };
}

/** The command a project's saved entries suggest for a new run. */
export function defaultCommand(workspace: Workspace): WorkspaceCommand | null {
  return (
    workspace.commands.find((command) => command.kind === "train") ?? workspace.commands[0] ?? null
  );
}
