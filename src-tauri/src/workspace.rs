//! Projects, experiment variants and runs.
//!
//! A workspace binds a saved login to one code directory on that server; an
//! experiment is a variant of that project (usually another directory or
//! branch, recorded relative to a baseline); a run is one launch of one
//! experiment. None of them refers to a terminal tab: a tab id dies with the
//! window, while these records outlive reconnects and restarts.
//!
//! The records live in `workspaces.json` next to the session profiles. The
//! file is written by the same owner-only helper as the other stores and is
//! never rewritten when the existing file cannot be read, so a corrupt file
//! is preserved for recovery instead of being replaced by an empty one.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::store::{data_dir, write_owner_only};

const MAX_WORKSPACES: usize = 200;
const MAX_EXPERIMENTS: usize = 1000;
const MAX_RUNS: usize = 3000;
const MAX_ID_LEN: usize = 100;
const MAX_NAME_LEN: usize = 120;
const MAX_ROOT_LEN: usize = 4096;
const MAX_COMMAND_LEN: usize = 8000;
const MAX_ENV_LEN: usize = 4000;
const MAX_NOTE_LEN: usize = 8000;
const MAX_RUN_FILES: usize = 5000;

/// The server a record belongs to. `profile_id` is the link to the saved
/// login; the rest is an identity snapshot so a record still says which
/// machine it means when the profile is renamed, moved or deleted.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
}

impl ServerRef {
    /// Stable identity for UI grouping and cache keys. Two projects on one
    /// server share it; two servers never do.
    pub fn key(&self) -> String {
        format!(
            "{}@{}:{}",
            self.username.trim(),
            self.host.trim(),
            if self.port == 0 { 22 } else { self.port }
        )
    }

    fn validate(&self) -> Result<()> {
        validate_id("server profile id", &self.profile_id)?;
        if self.host.trim().is_empty() {
            return Err(AppError::invalid_input("a project needs a server host"));
        }
        Ok(())
    }
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceCommandKind {
    Train,
    Validate,
    Infer,
    Shell,
    #[default]
    Other,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommand {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub command: String,
    #[serde(default = "default_command_kind")]
    pub kind: WorkspaceCommandKind,
}

fn default_command_kind() -> WorkspaceCommandKind {
    WorkspaceCommandKind::Other
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub server: ServerRef,
    /// Absolute directory of the project on the server (the baseline code).
    #[serde(default)]
    pub root: String,
    /// Shell prelude run before commands, e.g. `conda activate vfi`.
    #[serde(default)]
    pub env: String,
    #[serde(default)]
    pub commands: Vec<WorkspaceCommand>,
    /// Where this project's runs and logs are written. Empty means
    /// `<root>/.edgeterm/runs`.
    #[serde(default)]
    pub run_root: String,
    #[serde(default)]
    pub baseline_experiment_id: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExperimentKind {
    Baseline,
    #[default]
    Variant,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experiment {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_experiment_kind")]
    pub kind: ExperimentKind,
    /// The variant this one is measured against; empty for a baseline.
    #[serde(default)]
    pub baseline_id: Option<String>,
    /// Code directory when the variant lives outside the workspace root.
    #[serde(default)]
    pub root: Option<String>,
    /// Optional git branch the variant is expected to use. It is recorded,
    /// not checked out: launching never changes the user's working tree.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_experiment_kind() -> ExperimentKind {
    ExperimentKind::Variant
}

/// The code a run was launched from. A commit alone does not identify a
/// dirty tree, so the uncommitted diff is part of it; the digest is over the
/// bounded diff text (see `project::capture_code`).
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCodeState {
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub dirty_files: Vec<String>,
    #[serde(default)]
    pub diff_sha256: String,
    #[serde(default)]
    pub diff_bytes: u64,
    /// Whether the captured diff hit its byte limit. A truncated diff still
    /// identifies this launch, but it is not the whole change set.
    #[serde(default)]
    pub diff_truncated: bool,
    /// `true` only when git answered; a run outside a repository records
    /// no commit and says so instead of pretending.
    #[serde(default)]
    pub is_repository: bool,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotMode {
    #[default]
    None,
    Code,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    #[serde(default = "default_snapshot_mode")]
    pub mode: SnapshotMode,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub files: u64,
    #[serde(default)]
    pub bytes: u64,
    /// Files left out by the count, size or exclusion limits. Non-zero means
    /// the snapshot is not a complete copy of the project.
    #[serde(default)]
    pub skipped: u64,
    /// The copy was extracted and the file count matched the list it was
    /// built from. Only a verified snapshot may back an isolated run.
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub note: String,
}

/// Where a run's command actually executed. `Workspace` is the project
/// directory the user edits: the snapshot beside the run is then evidence of
/// what was there at launch, not a copy the run used. `Isolated` executes
/// inside that snapshot, with explicitly linked data directories.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    #[default]
    Workspace,
    Isolated,
}

/// What a launch was bound to, written beside the run and kept in the record.
/// It answers "which code, which directory, which edits" without implying
/// that a run is reproducible: environment packages, data and weights are
/// recorded only when the user or the server actually reported them.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBinding {
    #[serde(default)]
    pub execution: ExecutionMode,
    /// Absolute directory the command ran in.
    #[serde(default)]
    pub executed_from: String,
    #[serde(default)]
    pub workspace_root: String,
    /// Whether the executed directory was a copy made for this run.
    #[serde(default)]
    pub isolated: bool,
    #[serde(default)]
    pub snapshot_verified: bool,
    /// Files with unsaved local edits when the launch was confirmed. Their
    /// remote copies are what ran.
    #[serde(default)]
    pub unsynced: Vec<String>,
    /// Project-relative paths linked into the isolated copy (data, weights).
    #[serde(default)]
    pub links: Vec<String>,
    #[serde(default)]
    pub note: String,
}

fn default_snapshot_mode() -> SnapshotMode {
    SnapshotMode::None
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    #[default]
    Starting,
    Running,
    /// The launch command returned after submitting to a scheduler; the
    /// training itself is not observable through this run.
    Submitted,
    Finished,
    Failed,
    /// The process was alive when last checked but nothing can be confirmed
    /// now (the session is gone, or the host cannot be asked).
    Unknown,
    /// The process ended and its exit status could not be read.
    Lost,
    Stopped,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunMode {
    /// Executed in a named tmux session: reattachable and observable.
    #[default]
    Tmux,
    /// Executed under setsid/nohup: observable through its files, not
    /// reattachable interactively.
    Detached,
    /// Launched in a terminal tab; EdgeTerm does not manage its lifecycle.
    Terminal,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub experiment_id: String,
    #[serde(default)]
    pub server: ServerRef,
    /// Directory the command runs in (the experiment root, not necessarily
    /// the workspace root).
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub env: String,
    /// GPU selection as the user typed it (`0`, `0,1`, `none`). Nothing here
    /// translates it into a framework-specific variable.
    #[serde(default)]
    pub gpu: String,
    /// The scheduler the launch command submits to, when one was detected.
    #[serde(default)]
    pub scheduler: Option<String>,
    /// True when the command only submits work (for example `sbatch`); this
    /// client then observes the submission, not the training job.
    #[serde(default)]
    pub submit_only: bool,
    #[serde(default = "default_run_mode")]
    pub mode: RunMode,
    #[serde(default = "default_run_status")]
    pub status: RunStatus,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub exit_code: Option<u32>,
    #[serde(default)]
    pub code: RunCodeState,
    #[serde(default)]
    pub snapshot: RunSnapshot,
    /// The executed directory, its code copy and the edits that were still
    /// local at launch.
    #[serde(default)]
    pub binding: RunBinding,
    #[serde(default)]
    pub run_dir: String,
    #[serde(default)]
    pub log_path: String,
    /// tmux session name or detached process id file, whichever the mode uses.
    #[serde(default)]
    pub task_name: String,
    /// Run this one continues (for example a checkpoint resume). It is a
    /// link, not a claim that the new run reproduces the old one.
    #[serde(default)]
    pub resumed_from: Option<String>,
    #[serde(default)]
    pub note: String,
    /// Last time the launcher confirmed anything about the process. Stale
    /// values make the UI say "unknown", not "running".
    #[serde(default)]
    pub last_seen_at: i64,
}

fn default_run_mode() -> RunMode {
    RunMode::Tmux
}

fn default_run_status() -> RunStatus {
    RunStatus::Starting
}

/// What `update_run` may change after a launch. Code, command, environment
/// and paths are immutable: rewriting them would break the run's identity.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUpdate {
    pub id: String,
    pub status: RunStatus,
    #[serde(default)]
    pub exit_code: Option<u32>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub last_seen_at: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub experiments: Vec<Experiment>,
    #[serde(default)]
    pub runs: Vec<RunRecord>,
}

/// Loaded once at start-up; every mutation persists the whole file. The
/// records are small (no file contents), so this stays well below the cost of
/// one transfer chunk.
pub struct WorkspaceStore {
    path: PathBuf,
    data: Mutex<WorkspaceData>,
    load_error: Option<AppError>,
}

impl WorkspaceStore {
    pub fn load() -> Self {
        Self::load_from(data_dir().join("workspaces.json"))
    }

    pub fn load_from(path: PathBuf) -> Self {
        let (data, load_error) = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<WorkspaceData>(&raw) {
                Ok(mut data) => {
                    data.workspaces.retain(is_valid_workspace);
                    data.experiments.retain(is_valid_experiment);
                    data.runs.retain(is_valid_run);
                    (data, None)
                }
                Err(_) => (
                    WorkspaceData::default(),
                    Some(AppError::new(format!(
                        "Cannot read the project records at {}. The file has been left untouched; \
                         restore a readable file and restart EdgeTerm before saving projects.",
                        path.display()
                    ))),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (WorkspaceData::default(), None)
            }
            Err(_) => (
                WorkspaceData::default(),
                Some(AppError::new(format!(
                    "Cannot read the project records at {}.",
                    path.display()
                ))),
            ),
        };
        Self {
            path,
            data: Mutex::new(data),
            load_error,
        }
    }

    pub fn snapshot(&self) -> WorkspaceData {
        self.data.lock().clone()
    }

    pub fn save_workspace(&self, mut workspace: Workspace) -> Result<Workspace> {
        self.require_readable()?;
        workspace.name = clamp_text(&workspace.name, MAX_NAME_LEN);
        if workspace.name.is_empty() {
            return Err(AppError::invalid_input("a project needs a name"));
        }
        workspace.server.validate()?;
        workspace.root = validate_root(&workspace.root)?;
        workspace.run_root = if workspace.run_root.trim().is_empty() {
            String::new()
        } else {
            validate_root(&workspace.run_root)?
        };
        workspace.env = clamp_text(&workspace.env, MAX_ENV_LEN);
        if workspace.commands.len() > 50 {
            return Err(AppError::invalid_input(
                "a project holds at most 50 commands",
            ));
        }
        for command in &mut workspace.commands {
            command.id = clamp_text(&command.id, MAX_ID_LEN);
            if command.id.is_empty() {
                command.id = uuid::Uuid::new_v4().to_string();
            }
            command.label = clamp_text(&command.label, MAX_NAME_LEN);
            command.command = clamp_text(&command.command, MAX_COMMAND_LEN);
            if command.label.is_empty() {
                command.label = command.command.lines().next().unwrap_or("command").into();
            }
        }
        let now = now_ms();
        let mut data = self.data.lock();
        if workspace.id.is_empty() {
            workspace.id = uuid::Uuid::new_v4().to_string();
        }
        validate_id("workspace id", &workspace.id)?;
        if workspace.created_at == 0 {
            workspace.created_at = now;
        }
        workspace.updated_at = now;
        match data
            .workspaces
            .iter_mut()
            .find(|item| item.id == workspace.id)
        {
            Some(existing) => {
                workspace.created_at = existing.created_at;
                *existing = workspace.clone();
            }
            None => {
                if data.workspaces.len() >= MAX_WORKSPACES {
                    return Err(AppError::invalid_input(format!(
                        "at most {MAX_WORKSPACES} projects are kept"
                    )));
                }
                data.workspaces.push(workspace.clone());
            }
        }
        persist(&self.path, &data)?;
        Ok(workspace)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<WorkspaceData> {
        self.require_readable()?;
        let mut data = self.data.lock();
        let before = data.workspaces.len();
        data.workspaces.retain(|workspace| workspace.id != id);
        if data.workspaces.len() == before {
            return Err(AppError::invalid_input("no such project"));
        }
        data.experiments
            .retain(|experiment| experiment.workspace_id != id);
        data.runs.retain(|run| run.workspace_id != id);
        persist(&self.path, &data)?;
        Ok(data.clone())
    }

    pub fn save_experiment(&self, mut experiment: Experiment) -> Result<Experiment> {
        self.require_readable()?;
        experiment.name = clamp_text(&experiment.name, MAX_NAME_LEN);
        if experiment.name.is_empty() {
            return Err(AppError::invalid_input("an experiment needs a name"));
        }
        experiment.notes = clamp_text(&experiment.notes, MAX_NOTE_LEN);
        if experiment.id.is_empty() {
            experiment.id = uuid::Uuid::new_v4().to_string();
        }
        validate_id("experiment id", &experiment.id)?;
        let mut data = self.data.lock();
        if !data
            .workspaces
            .iter()
            .any(|workspace| workspace.id == experiment.workspace_id)
        {
            return Err(AppError::invalid_input("the project no longer exists"));
        }
        experiment.root = match experiment.root {
            Some(root) if root.trim().is_empty() => None,
            Some(root) => Some(validate_root(&root)?),
            None => None,
        };
        experiment.branch = experiment
            .branch
            .map(|branch| clamp_text(&branch, MAX_NAME_LEN))
            .filter(|branch| !branch.is_empty());

        match experiment.kind {
            ExperimentKind::Baseline => {
                if data.experiments.iter().any(|candidate| {
                    candidate.workspace_id == experiment.workspace_id
                        && candidate.kind == ExperimentKind::Baseline
                        && candidate.id != experiment.id
                }) {
                    return Err(AppError::invalid_input(
                        "this project already has a baseline; edit it or make a variant",
                    ));
                }
                experiment.baseline_id = None;
            }
            ExperimentKind::Variant => {
                let baseline_id = experiment.baseline_id.as_deref().unwrap_or("");
                let valid = data.experiments.iter().any(|candidate| {
                    candidate.id == baseline_id
                        && candidate.workspace_id == experiment.workspace_id
                        && candidate.kind == ExperimentKind::Baseline
                        && candidate.id != experiment.id
                });
                if !valid {
                    return Err(AppError::invalid_input(
                        "choose the baseline this variant is measured against",
                    ));
                }
            }
        }

        let now = now_ms();
        if experiment.created_at == 0 {
            experiment.created_at = now;
        }
        experiment.updated_at = now;
        match data
            .experiments
            .iter_mut()
            .find(|item| item.id == experiment.id)
        {
            Some(existing) => {
                experiment.created_at = existing.created_at;
                *existing = experiment.clone();
            }
            None => {
                if data.experiments.len() >= MAX_EXPERIMENTS {
                    return Err(AppError::invalid_input(format!(
                        "at most {MAX_EXPERIMENTS} experiments are kept"
                    )));
                }
                data.experiments.push(experiment.clone());
            }
        }
        if experiment.kind == ExperimentKind::Baseline {
            if let Some(workspace) = data
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.id == experiment.workspace_id)
            {
                workspace.baseline_experiment_id = Some(experiment.id.clone());
            }
        }
        persist(&self.path, &data)?;
        Ok(experiment)
    }

    pub fn delete_experiment(&self, id: &str) -> Result<WorkspaceData> {
        self.require_readable()?;
        let mut data = self.data.lock();
        let before = data.experiments.len();
        data.experiments.retain(|experiment| experiment.id != id);
        if data.experiments.len() == before {
            return Err(AppError::invalid_input("no such experiment"));
        }
        data.runs.retain(|run| run.experiment_id != id);
        for experiment in &mut data.experiments {
            if experiment.baseline_id.as_deref() == Some(id) {
                experiment.baseline_id = None;
            }
        }
        for workspace in &mut data.workspaces {
            if workspace.baseline_experiment_id.as_deref() == Some(id) {
                workspace.baseline_experiment_id = None;
            }
        }
        persist(&self.path, &data)?;
        Ok(data.clone())
    }

    pub fn record_run(&self, mut run: RunRecord) -> Result<RunRecord> {
        self.require_readable()?;
        validate_id("run id", &run.id)?;
        run.server.validate()?;
        run.root = validate_root(&run.root)?;
        run.command = clamp_text(&run.command, MAX_COMMAND_LEN);
        if run.command.trim().is_empty() {
            return Err(AppError::invalid_input("a run needs a command"));
        }
        run.env = clamp_text(&run.env, MAX_ENV_LEN);
        run.gpu = clamp_text(&run.gpu, MAX_NAME_LEN);
        run.note = clamp_text(&run.note, MAX_NOTE_LEN);
        // The binding is evidence, not input: keep its fields bounded and
        // never rewrite them on a re-record (only observations change there).
        run.binding.executed_from = clamp_text(&run.binding.executed_from, MAX_ROOT_LEN);
        run.binding.workspace_root = clamp_text(&run.binding.workspace_root, MAX_ROOT_LEN);
        run.binding.note = clamp_text(&run.binding.note, MAX_NOTE_LEN);
        run.binding.unsynced.truncate(MAX_RUN_FILES);
        for file in &mut run.binding.unsynced {
            *file = clamp_text(file, MAX_ROOT_LEN);
        }
        run.binding.links.truncate(MAX_RUN_FILES);
        for link in &mut run.binding.links {
            *link = clamp_text(link, MAX_ROOT_LEN);
        }
        if run.binding.isolated && run.binding.executed_from.trim().is_empty() {
            return Err(AppError::invalid_input(
                "an isolated run must record the directory it executed in",
            ));
        }
        if run.code.dirty_files.len() > MAX_RUN_FILES {
            run.code.dirty_files.truncate(MAX_RUN_FILES);
        }
        for file in &mut run.code.dirty_files {
            *file = clamp_text(file, MAX_ROOT_LEN);
        }
        if run.started_at == 0 {
            run.started_at = now_ms();
        }
        if run.last_seen_at == 0 {
            run.last_seen_at = run.started_at;
        }
        let mut data = self.data.lock();
        if !data
            .workspaces
            .iter()
            .any(|workspace| workspace.id == run.workspace_id)
        {
            return Err(AppError::invalid_input("the project no longer exists"));
        }
        if !data.experiments.iter().any(|experiment| {
            experiment.id == run.experiment_id && experiment.workspace_id == run.workspace_id
        }) {
            return Err(AppError::invalid_input(
                "the experiment does not belong to this project",
            ));
        }
        match data.runs.iter_mut().find(|item| item.id == run.id) {
            Some(existing) => {
                // A run's launch identity is immutable; only its observation
                // fields may be refreshed here.
                let status = run.status;
                let exit_code = run.exit_code;
                let ended_at = run.ended_at;
                let last_seen_at = run.last_seen_at;
                let note = run.note;
                existing.status = status;
                existing.exit_code = exit_code;
                existing.ended_at = ended_at;
                existing.last_seen_at = last_seen_at;
                existing.note = note;
                run = existing.clone();
            }
            None => {
                if data.runs.len() >= MAX_RUNS {
                    prune_runs(&mut data.runs);
                }
                data.runs.push(run.clone());
            }
        }
        persist(&self.path, &data)?;
        Ok(run)
    }

    pub fn update_run(&self, update: RunUpdate) -> Result<RunRecord> {
        self.require_readable()?;
        let mut data = self.data.lock();
        let run = data
            .runs
            .iter_mut()
            .find(|run| run.id == update.id)
            .ok_or_else(|| AppError::invalid_input("no such run"))?;
        run.status = update.status;
        if update.exit_code.is_some() {
            run.exit_code = update.exit_code;
        }
        if update.ended_at.is_some() {
            run.ended_at = update.ended_at;
        }
        if update.last_seen_at > 0 {
            run.last_seen_at = update.last_seen_at;
        }
        if let Some(note) = update.note {
            run.note = clamp_text(&note, MAX_NOTE_LEN);
        }
        let saved = run.clone();
        persist(&self.path, &data)?;
        Ok(saved)
    }

    pub fn delete_run(&self, id: &str) -> Result<WorkspaceData> {
        self.require_readable()?;
        let mut data = self.data.lock();
        let before = data.runs.len();
        data.runs.retain(|run| run.id != id);
        if data.runs.len() == before {
            return Err(AppError::invalid_input("no such run"));
        }
        persist(&self.path, &data)?;
        Ok(data.clone())
    }

    fn require_readable(&self) -> Result<()> {
        match &self.load_error {
            Some(error) => Err(AppError::new(error.message.clone())),
            None => Ok(()),
        }
    }
}

fn persist(path: &Path, data: &WorkspaceData) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(data)?;
    write_owner_only(path, &raw)
}

/// Keeps the file bounded without dropping a running launch: finished runs
/// older than the cap go first, then the oldest records of any status.
fn prune_runs(runs: &mut Vec<RunRecord>) {
    if runs.len() < MAX_RUNS {
        return;
    }
    runs.sort_by_key(|run| run.started_at);
    let excess = runs.len() - MAX_RUNS + 1;
    let mut removed = 0;
    let mut index = 0;
    while removed < excess && index < runs.len() {
        let finished = matches!(
            runs[index].status,
            RunStatus::Finished | RunStatus::Failed | RunStatus::Stopped | RunStatus::Lost
        );
        if finished {
            runs.remove(index);
            removed += 1;
        } else {
            index += 1;
        }
    }
    while removed < excess && !runs.is_empty() {
        runs.remove(0);
        removed += 1;
    }
}

fn is_valid_workspace(workspace: &Workspace) -> bool {
    valid_id(&workspace.id)
        && !workspace.name.trim().is_empty()
        && !workspace.root.trim().is_empty()
}

fn is_valid_experiment(experiment: &Experiment) -> bool {
    valid_id(&experiment.id)
        && valid_id(&experiment.workspace_id)
        && !experiment.name.trim().is_empty()
}

fn is_valid_run(run: &RunRecord) -> bool {
    valid_id(&run.id) && valid_id(&run.workspace_id) && valid_id(&run.experiment_id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_id(label: &str, id: &str) -> Result<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AppError::invalid_input(format!(
            "{label} must be 1-{MAX_ID_LEN} letters, digits, '-' or '_'"
        )))
    }
}

fn validate_root(root: &str) -> Result<String> {
    let root = root.trim();
    if root.is_empty() {
        return Err(AppError::invalid_input("a project needs a root directory"));
    }
    if root.len() > MAX_ROOT_LEN {
        return Err(AppError::invalid_input("the root directory is too long"));
    }
    if root.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::invalid_input(
            "the root directory contains an unsupported character",
        ));
    }
    Ok(root.to_string())
}

fn clamp_text(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("edgeterm-workspace-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn server() -> ServerRef {
        ServerRef {
            profile_id: "profile-1".into(),
            name: "gpu-01".into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "lab".into(),
        }
    }

    fn workspace(store: &WorkspaceStore, name: &str, root: &str) -> Workspace {
        store
            .save_workspace(Workspace {
                name: name.into(),
                server: server(),
                root: root.into(),
                ..Default::default()
            })
            .unwrap()
    }

    fn baseline(store: &WorkspaceStore, workspace_id: &str) -> Experiment {
        store
            .save_experiment(Experiment {
                workspace_id: workspace_id.into(),
                name: "baseline".into(),
                kind: ExperimentKind::Baseline,
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn three_projects_keep_their_own_server_and_root() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let base = workspace(&store, "vfi baseline", "/data/vfi/base");
        let ablation = workspace(&store, "ablation A", "/data/vfi/abl_a");
        let other = workspace(&store, "ablation B", "/mnt/fast/vfi/abl_b");
        assert_ne!(base.id, ablation.id);
        assert_eq!(base.server.key(), other.server.key(), "same login");
        assert_ne!(base.root, other.root);

        let reloaded = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let data = reloaded.snapshot();
        assert_eq!(data.workspaces.len(), 3);
        for item in [&base, &ablation, &other] {
            let found = data.workspaces.iter().find(|w| w.id == item.id).unwrap();
            assert_eq!(found.root, item.root);
            assert_eq!(found.server.profile_id, "profile-1");
        }
    }

    #[test]
    fn deleting_a_project_removes_only_its_experiments_and_runs() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let first = workspace(&store, "baseline", "/data/base");
        let second = workspace(&store, "ablation", "/data/abl");
        let first_baseline = baseline(&store, &first.id);
        let second_baseline = baseline(&store, &second.id);
        let run = |id: &str, workspace_id: &str, experiment_id: &str| RunRecord {
            id: id.into(),
            workspace_id: workspace_id.into(),
            experiment_id: experiment_id.into(),
            server: server(),
            root: "/data".into(),
            command: "python train.py".into(),
            status: RunStatus::Running,
            ..Default::default()
        };
        store
            .record_run(run("run-a", &first.id, &first_baseline.id))
            .unwrap();
        store
            .record_run(run("run-b", &second.id, &second_baseline.id))
            .unwrap();

        let data = store.delete_workspace(&first.id).unwrap();
        assert_eq!(data.workspaces.len(), 1);
        assert_eq!(data.experiments.len(), 1);
        assert_eq!(data.experiments[0].workspace_id, second.id);
        assert_eq!(data.runs.len(), 1);
        assert_eq!(data.runs[0].id, "run-b");
    }

    #[test]
    fn a_project_has_at_most_one_baseline() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let project = workspace(&store, "baseline", "/data/base");
        baseline(&store, &project.id);
        let second = store.save_experiment(Experiment {
            workspace_id: project.id.clone(),
            name: "second baseline".into(),
            kind: ExperimentKind::Baseline,
            ..Default::default()
        });
        assert!(second.is_err());
    }

    #[test]
    fn a_variant_must_reference_a_baseline_of_its_own_project() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let first = workspace(&store, "baseline", "/data/base");
        let second = workspace(&store, "ablation", "/data/abl");
        let first_baseline = baseline(&store, &first.id);
        let second_baseline = baseline(&store, &second.id);

        let foreign = store.save_experiment(Experiment {
            workspace_id: second.id.clone(),
            name: "wrong link".into(),
            kind: ExperimentKind::Variant,
            baseline_id: Some(first_baseline.id.clone()),
            ..Default::default()
        });
        assert!(foreign.is_err());

        let variant = store
            .save_experiment(Experiment {
                workspace_id: second.id.clone(),
                name: "ablation A".into(),
                kind: ExperimentKind::Variant,
                baseline_id: Some(second_baseline.id.clone()),
                root: Some("/data/abl_a".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            variant.baseline_id.as_deref(),
            Some(second_baseline.id.as_str())
        );
    }

    #[test]
    fn a_run_must_belong_to_an_experiment_of_its_project() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let first = workspace(&store, "baseline", "/data/base");
        let second = workspace(&store, "ablation", "/data/abl");
        let first_baseline = baseline(&store, &first.id);
        let second_baseline = baseline(&store, &second.id);

        let wrong = store.record_run(RunRecord {
            id: "run-1".into(),
            workspace_id: first.id.clone(),
            experiment_id: second_baseline.id.clone(),
            server: server(),
            root: "/data".into(),
            command: "python train.py".into(),
            ..Default::default()
        });
        assert!(wrong.is_err());

        let right = store
            .record_run(RunRecord {
                id: "run-1".into(),
                workspace_id: first.id.clone(),
                experiment_id: first_baseline.id.clone(),
                server: server(),
                root: "/data".into(),
                command: "python train.py".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(right.status, RunStatus::Starting);
        assert!(right.started_at > 0);
    }

    #[test]
    fn recording_an_existing_run_cannot_rewrite_its_launch_identity() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        let project = workspace(&store, "baseline", "/data/base");
        let experiment = baseline(&store, &project.id);
        store
            .record_run(RunRecord {
                id: "run-1".into(),
                workspace_id: project.id.clone(),
                experiment_id: experiment.id.clone(),
                server: server(),
                root: "/data/base".into(),
                command: "python train.py".into(),
                ..Default::default()
            })
            .unwrap();
        let updated = store
            .record_run(RunRecord {
                id: "run-1".into(),
                workspace_id: project.id.clone(),
                experiment_id: experiment.id.clone(),
                server: server(),
                root: "/somewhere/else".into(),
                command: "rm -rf /".into(),
                status: RunStatus::Finished,
                exit_code: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(updated.command, "python train.py");
        assert_eq!(updated.root, "/data/base");
        assert_eq!(updated.status, RunStatus::Finished);
        assert_eq!(updated.exit_code, Some(0));
    }

    #[test]
    fn a_corrupt_file_is_preserved_and_writes_are_refused() {
        let dir = TempDir::new();
        let path = dir.0.join("workspaces.json");
        std::fs::write(&path, b"{not json").unwrap();
        let store = WorkspaceStore::load_from(path.clone());
        let result = store.save_workspace(Workspace {
            name: "new".into(),
            server: server(),
            root: "/data".into(),
            ..Default::default()
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }

    #[test]
    fn invalid_roots_and_ids_are_rejected_without_writing() {
        let dir = TempDir::new();
        let store = WorkspaceStore::load_from(dir.0.join("workspaces.json"));
        assert!(store
            .save_workspace(Workspace {
                name: "bad".into(),
                server: server(),
                root: "relative\npath".into(),
                ..Default::default()
            })
            .is_err());
        assert!(store
            .save_workspace(Workspace {
                id: "../escape".into(),
                name: "bad".into(),
                server: server(),
                root: "/data".into(),
                ..Default::default()
            })
            .is_err());
        assert!(store.snapshot().workspaces.is_empty());
    }

    #[test]
    fn server_identity_ignores_the_display_name_but_not_the_login() {
        let first = server();
        let mut renamed = first.clone();
        renamed.name = "renamed".into();
        assert_eq!(first.key(), renamed.key());
        let mut other_user = first.clone();
        other_user.username = "other".into();
        assert_ne!(first.key(), other_user.key());
        let mut other_port = first.clone();
        other_port.port = 2222;
        assert_ne!(first.key(), other_port.key());
    }

    #[test]
    fn pruning_keeps_running_launches_and_drops_old_finished_runs() {
        let mut runs: Vec<RunRecord> = (0..MAX_RUNS + 1)
            .map(|index| RunRecord {
                id: format!("run-{index}"),
                started_at: index as i64,
                status: if index == 0 {
                    RunStatus::Running
                } else {
                    RunStatus::Finished
                },
                ..Default::default()
            })
            .collect();
        prune_runs(&mut runs);
        // One slot is freed for the run that is about to be recorded.
        assert_eq!(runs.len(), MAX_RUNS - 1);
        assert!(runs.iter().any(|run| run.id == "run-0"));
        assert!(!runs.iter().any(|run| run.id == "run-1"));
    }
}
