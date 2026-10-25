import type * as Wire from "../bindings";

/**
 * The workbench's own records. They mirror the Rust structs in
 * `src-tauri/src/workspace.rs`, but every persisted field is required here:
 * the backend fills defaults on save, and a view that had to handle
 * `undefined` for a project's root would only spread that uncertainty
 * through the UI.
 */
export interface ServerRef {
  profileId: string;
  name: string;
  host: string;
  port: number;
  username: string;
}

export type WorkspaceCommandKind = Wire.WorkspaceCommandKind;

export interface WorkspaceCommand {
  id: string;
  label: string;
  command: string;
  kind: WorkspaceCommandKind;
}

export interface Workspace {
  id: string;
  name: string;
  server: ServerRef;
  root: string;
  env: string;
  commands: WorkspaceCommand[];
  runRoot: string;
  baselineExperimentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ExperimentKind = Wire.ExperimentKind;

export interface Experiment {
  id: string;
  workspaceId: string;
  name: string;
  kind: ExperimentKind;
  baselineId: string | null;
  root: string | null;
  branch: string | null;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunCodeState {
  branch: string;
  commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  diffSha256: string;
  diffBytes: number;
  diffTruncated: boolean;
  isRepository: boolean;
}

export type SnapshotMode = Wire.SnapshotMode;
export type ExecutionMode = Wire.ExecutionMode;

export interface RunSnapshot {
  mode: SnapshotMode;
  path: string;
  files: number;
  bytes: number;
  skipped: number;
  /** The copy was extracted and its file count matched the list. */
  verified: boolean;
  note: string;
}

/**
 * What a launch executed. `executedFrom` is the directory the command really
 * ran in; for an isolated run it is the copy beside the run, not the project
 * the editor is still editing.
 */
export interface RunBinding {
  execution: ExecutionMode;
  executedFrom: string;
  workspaceRoot: string;
  isolated: boolean;
  snapshotVerified: boolean;
  /** Files whose unsaved edits were not in the run. */
  unsynced: string[];
  /** Project-relative data directories linked into an isolated copy. */
  links: string[];
  note: string;
}

export type RunStatus = Wire.RunStatus;
export type RunMode = Wire.RunMode;

export interface RunRecord {
  id: string;
  workspaceId: string;
  experimentId: string;
  server: ServerRef;
  root: string;
  command: string;
  env: string;
  gpu: string;
  scheduler: string | null;
  submitOnly: boolean;
  mode: RunMode;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  code: RunCodeState;
  snapshot: RunSnapshot;
  binding: RunBinding;
  runDir: string;
  logPath: string;
  taskName: string;
  resumedFrom: string | null;
  note: string;
  lastSeenAt: number;
}

export interface WorkspaceData {
  workspaces: Workspace[];
  experiments: Experiment[];
  runs: RunRecord[];
}

export interface ProjectProbe {
  os: string;
  home: string;
  shell: string;
  git: boolean;
  tmux: boolean;
  python: string | null;
  conda: boolean;
  nvidiaSmi: boolean;
  scheduler: string | null;
  isRepository: boolean;
  rootExists: boolean;
  paths: string[];
}

export interface TextFile {
  path: string;
  content: string;
  hash: string;
  size: number;
  encoding: string;
  eol: string;
  bom: boolean;
  modifiedAt: number | null;
  permissions: number | null;
}

export interface FileList {
  root: string;
  files: string[];
  truncated: boolean;
  source: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  root: string;
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
  skipped: string;
}

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitState {
  isRepository: boolean;
  branch: string;
  commit: string;
  dirty: boolean;
  files: GitFileChange[];
  diffSha256: string;
  diffBytes: number;
  diffTruncated: boolean;
  note: string;
}

export interface DiffText {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface LogChunk {
  path: string;
  content: string;
  offset: number;
  size: number;
  reset: boolean;
  exists: boolean;
}

export interface RunLaunch {
  run: RunRecord;
  warnings: string[];
  /** The launcher's own result could not be read; poll the run record. */
  uncertain: boolean;
}

export interface RunObservation {
  status: RunStatus;
  exitCode: number | null;
  alive: boolean;
  logSize: number;
  checkedAt: number;
  note: string;
}

export interface FileStat {
  path: string;
  exists: boolean;
  size: number;
  modifiedAt: number | null;
}

/** The editor's per-file state, keyed by workspace and absolute remote path. */
export type DocSync = "loading" | "synced" | "dirty" | "saving" | "conflict" | "failed";

/** Whether the local draft of a dirty document is safely on disk. */
export type DraftState = "idle" | "pending" | "saved" | "failed";

export interface EditorDoc {
  /** `${workspaceId}::${absolutePath}`; stable across tab switches. */
  id: string;
  workspaceId: string;
  experimentId: string;
  serverKey: string;
  serverLabel: string;
  projectName: string;
  /** Relative path inside the project root; the tab's title. */
  path: string;
  absolutePath: string;
  content: string;
  /** The server copy as last read or written, for a local dirty check. */
  savedContent: string;
  hash: string;
  /** The hash of the copy the draft was based on, when it differs. */
  remoteHash: string | null;
  size: number;
  encoding: string;
  eol: string;
  bom: boolean;
  modifiedAt: number | null;
  sync: DocSync;
  error: string | null;
  draftRestored: boolean;
  /** The unsaved content is stored locally, still being written, or lost. */
  draftState: DraftState;
  draftError: string | null;
  /** Set when an editor was asked to reveal a search hit. */
  revealLine: number | null;
  lastActiveAt: number;
}

export interface ServerIdentity {
  key: string;
  server: ServerRef;
  workspaceIds: string[];
}
