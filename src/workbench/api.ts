import type { FileComparison } from "../api";
import { commands } from "../bindings";
import { normalizeData, normalizeExperiment, normalizeRun, normalizeWorkspace } from "./model";
import type {
  DiffText,
  ExecutionMode,
  Experiment,
  FileList,
  FileStat,
  GitState,
  LogChunk,
  ProjectProbe,
  RunLaunch,
  RunObservation,
  RunRecord,
  RunStatus,
  SearchResult,
  SnapshotMode,
  TextFile,
  Workspace,
  WorkspaceData,
} from "./types";

/**
 * The workbench's IPC surface. Every persisted record is normalized here so a
 * missing field from an older file cannot turn into `undefined` deep inside a
 * view.
 */

export const loadData = async (): Promise<WorkspaceData> =>
  normalizeData(await commands.listWorkspaceData());

export const saveWorkspace = async (workspace: Workspace): Promise<Workspace> =>
  normalizeWorkspace(await commands.saveWorkspace(workspace));

export const deleteWorkspace = async (id: string): Promise<WorkspaceData> =>
  normalizeData(await commands.deleteWorkspace(id));

export const saveExperiment = async (experiment: Experiment): Promise<Experiment> =>
  normalizeExperiment(await commands.saveExperiment(experiment));

export const deleteExperiment = async (id: string): Promise<WorkspaceData> =>
  normalizeData(await commands.deleteExperiment(id));

export const recordRun = async (run: RunRecord): Promise<RunRecord> =>
  normalizeRun(await commands.recordRun(run));

export const updateRun = async (update: {
  id: string;
  status: RunStatus;
  exitCode?: number | null;
  endedAt?: number | null;
  lastSeenAt: number;
  note?: string | null;
}): Promise<RunRecord> => normalizeRun(await commands.updateRun(update));

export const deleteRun = async (id: string): Promise<WorkspaceData> =>
  normalizeData(await commands.deleteRun(id));

export const probe = (sessionId: string, root: string): Promise<ProjectProbe> =>
  commands.projectProbe(sessionId, root);

export const readText = (sessionId: string | null, path: string): Promise<TextFile> =>
  commands.projectReadText(sessionId, path) as Promise<TextFile>;

export const writeText = (
  sessionId: string | null,
  request: {
    path: string;
    content: string;
    expectedHash: string | null;
    eol: string;
    bom: boolean;
    force?: boolean;
    encoding?: string;
  },
): Promise<{
  path: string;
  hash: string;
  size: number;
  backup: string | null;
  temp: string | null;
  uncertain: boolean;
  note: string;
}> =>
  commands.projectWriteText(sessionId, request).then((result) => ({
    path: result.path,
    hash: result.hash,
    size: result.size,
    backup: result.backup ?? null,
    temp: result.temp ?? null,
    uncertain: result.uncertain ?? false,
    note: result.note ?? "",
  }));

export const statFile = (sessionId: string, path: string): Promise<FileStat> =>
  commands.projectFileStat(sessionId, path);

export const listFiles = (sessionId: string, root: string): Promise<FileList> =>
  commands.projectListFiles(sessionId, root) as Promise<FileList>;

export const search = (sessionId: string, root: string, query: string): Promise<SearchResult> =>
  commands.projectSearch(sessionId, root, query) as Promise<SearchResult>;

export const gitState = (sessionId: string, root: string): Promise<GitState> =>
  commands.projectGitState(sessionId, root) as Promise<GitState>;

export const gitDiff = (sessionId: string, root: string, path: string | null): Promise<DiffText> =>
  commands.projectGitDiff(sessionId, root, path) as Promise<DiffText>;

export const readLog = (sessionId: string, path: string, offset: number): Promise<LogChunk> =>
  commands.projectReadLog(sessionId, path, offset) as Promise<LogChunk>;

export const startRun = (
  sessionId: string,
  request: {
    run: RunRecord;
    runRoot: string;
    snapshot: SnapshotMode;
    excludes: string[];
    execution: ExecutionMode;
    links: string[];
    unsynced: string[];
    requireClean: boolean;
  },
): Promise<RunLaunch> =>
  commands.projectStartRun(sessionId, request) as unknown as Promise<RunLaunch>;

export const runStatus = (sessionId: string, run: RunRecord): Promise<RunObservation> =>
  commands.projectRunStatus(sessionId, run) as Promise<RunObservation>;

export const stopRun = (sessionId: string, run: RunRecord): Promise<null> =>
  commands.projectStopRun(sessionId, run);

export const compare = (
  leftSession: string,
  leftPath: string,
  rightSession: string,
  rightPath: string,
): Promise<FileComparison> =>
  commands.projectCompare(
    leftSession,
    leftPath,
    rightSession,
    rightPath,
  ) as unknown as Promise<FileComparison>;
