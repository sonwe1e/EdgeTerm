//! What the project workbench asks a server to do: read and write one text
//! file, list or search code, capture git state, tail a log, and launch a run.
//!
//! Everything here goes through the SSH transport a live session already
//! owns (`session::ssh::SharedTransport`), reusing its connection rather than
//! dialling a second one. Bounds are deliberate: text reads stop at 4 MiB,
//! diffs and log chunks at 512/128 KiB, listings at 20k entries and searches
//! at 500 matches. Nothing here walks a dataset or checkpoint directory for a
//! diff, and a run never copies weights.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode, Result};
use crate::file_diff::Comparison;
use crate::file_transfer::Control;
use crate::model::SessionProfile;
use crate::session::exec::{self, ExecStatus};
use crate::session::ssh::SharedTransport;
use crate::workspace::{
    now_ms, ExecutionMode, RunBinding, RunCodeState, RunMode, RunRecord, RunSnapshot, RunStatus,
    SnapshotMode,
};

const TEXT_LIMIT: usize = 4 * 1024 * 1024;
const DIFF_LIMIT: usize = 512 * 1024;
const LOG_CHUNK: u64 = 128 * 1024;
const LOG_TAIL: u64 = 64 * 1024;
const LIST_LIMIT: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_SNAPSHOT_FILES: usize = 2000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Directories a project query never descends into: version-control
/// Directories skipped wherever they appear: version-control metadata,
/// environments and caches. These never hold project code.
const ALWAYS_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".cache",
];

/// Large trees skipped when they are the project's own top-level children.
/// The distinction matters: `data/clip.mp4` is a dataset, while
/// `src/data/loader.py` is code and must stay listed and searchable.
const TOP_LEVEL_EXCLUDED_DIRS: &[&str] = &[
    "wandb",
    "lightning_logs",
    "data",
    "datasets",
    "dataset",
    "checkpoints",
    "checkpoint",
    "ckpt",
    "weights",
    "outputs",
    "output",
    "runs",
    "logs",
    "frames",
    "videos",
];

/// Binary artifacts that are not code even when they sit beside it.
const BINARY_EXTENSIONS: &[&str] = &[
    "pt",
    "pth",
    "ckpt",
    "bin",
    "npy",
    "npz",
    "h5",
    "hdf5",
    "pkl",
    "pickle",
    "onnx",
    "engine",
    "mp4",
    "mov",
    "avi",
    "mkv",
    "webm",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "tiff",
    "zip",
    "tar",
    "gz",
    "bz2",
    "xz",
    "7z",
    "rar",
    "pdf",
    "so",
    "dylib",
    "dll",
    "o",
    "a",
    "pyc",
    "pyo",
    "pyd",
    "whl",
    "safetensors",
];

/// Extensions and file names the quick-open list keeps. Config and script
/// formats are included on purpose: the workbench edits them too.
const TEXT_EXTENSIONS: &[&str] = &[
    "py",
    "pyi",
    "ipynb",
    "json",
    "json5",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "md",
    "rst",
    "txt",
    "j2",
    "jinja",
    "jinja2",
    "template",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "sql",
    "service",
    "env",
    "properties",
    "lock",
    "gitignore",
    "dockerignore",
    "editorconfig",
];

const TEXT_NAMES: &[&str] = &[
    "Dockerfile",
    "Makefile",
    "makefile",
    "LICENSE",
    "requirements.txt",
    "environment.yml",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
];

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProbe {
    pub os: String,
    pub home: String,
    pub shell: String,
    pub git: bool,
    pub tmux: bool,
    pub python: Option<String>,
    pub conda: bool,
    pub nvidia_smi: bool,
    pub scheduler: Option<String>,
    pub is_repository: bool,
    pub root_exists: bool,
    /// `git`, `tmux`, `python`… as the server's `command -v` printed them.
    pub paths: Vec<String>,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    /// SHA-256 of the exact bytes on the server, used as the write's CAS
    /// token.
    pub hash: String,
    pub size: u64,
    pub encoding: String,
    pub eol: String,
    pub bom: bool,
    pub modified_at: Option<i64>,
    pub permissions: Option<u32>,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWrite {
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
    /// `lf`, `crlf` or `cr`; a save keeps the file's existing convention.
    #[serde(default = "default_eol")]
    pub eol: String,
    #[serde(default)]
    pub bom: bool,
    /// Replace the server's copy even though its hash is not the expected
    /// one. Only the explicit overwrite action sets this.
    #[serde(default)]
    pub force: bool,
    /// The encoding the file was read with (`UTF-8`, `GBK`, …). Saving with
    /// it preserves a non-UTF-8 source instead of silently converting it.
    #[serde(default)]
    pub encoding: Option<String>,
}

fn default_eol() -> String {
    "lf".into()
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    /// The path the file was actually written to. It can differ from the
    /// request when the parent directory was reached through a symlink.
    pub path: String,
    pub hash: String,
    pub size: u64,
    /// A copy of the previous content, kept because the replace could not be
    /// confirmed. The path exists on the server.
    #[serde(default)]
    pub backup: Option<String>,
    /// The new content still sitting under a temporary name on the server.
    #[serde(default)]
    pub temp: Option<String>,
    /// The replace could not be verified: the bytes may or may not be in
    /// place. Callers must keep their recovery material.
    #[serde(default)]
    pub uncertain: bool,
    #[serde(default)]
    pub note: String,
}

/// A cheap "did it change?" probe: no content, so an open editor can notice a
/// remote edit without downloading the file again.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    pub modified_at: Option<i64>,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub root: String,
    pub files: Vec<String>,
    pub truncated: bool,
    /// `git` (tracked + untracked, honouring .gitignore) or `find`.
    pub source: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub root: String,
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub skipped: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    /// `M`, `A`, `D`, `R`, `??` … straight from `git status --porcelain`.
    pub status: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub is_repository: bool,
    pub branch: String,
    pub commit: String,
    pub dirty: bool,
    pub files: Vec<GitFileChange>,
    pub diff_sha256: String,
    pub diff_bytes: u64,
    pub diff_truncated: bool,
    pub note: String,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffText {
    pub text: String,
    pub truncated: bool,
    pub bytes: u64,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub path: String,
    pub content: String,
    pub offset: u64,
    pub size: u64,
    /// The reader restarted from the tail because the requested offset was
    /// past the end (a log was rotated or truncated).
    pub reset: bool,
    pub exists: bool,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub run: RunRecord,
    /// Where run directories live; empty means `<root>/.edgeterm/runs`.
    #[serde(default)]
    pub run_root: String,
    #[serde(default = "default_snapshot")]
    pub snapshot: SnapshotMode,
    /// Extra relative directories or files kept out of the code snapshot.
    #[serde(default)]
    pub excludes: Vec<String>,
    /// Run in the project directory (`Workspace`) or in this run's code copy
    /// (`Isolated`). Isolation needs a verified snapshot.
    #[serde(default)]
    pub execution: ExecutionMode,
    /// Project-relative paths linked into an isolated copy: datasets and
    /// weights that were excluded from the snapshot.
    #[serde(default)]
    pub links: Vec<String>,
    /// Files the editor still holds unsaved edits for. Their remote copies
    /// are what a run executes; the list is recorded with the run.
    #[serde(default)]
    pub unsynced: Vec<String>,
    /// Refuse to launch while `unsynced` is non-empty. The UI sets this
    /// unless the user explicitly confirmed using the remote copies; the
    /// default is the safe one.
    #[serde(default = "default_true")]
    pub require_clean: bool,
}

fn default_true() -> bool {
    true
}

fn default_snapshot() -> SnapshotMode {
    SnapshotMode::Code
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLaunch {
    pub run: RunRecord,
    pub warnings: Vec<String>,
    /// The launch command's own result could not be read. The run record
    /// exists, so the UI can poll it instead of starting a second copy.
    #[serde(default)]
    pub uncertain: bool,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunObservation {
    pub status: RunStatus,
    pub exit_code: Option<u32>,
    pub alive: bool,
    pub log_size: u64,
    pub checked_at: i64,
    pub note: String,
}

/// The `__ET__:source` line and the NUL-separated path list that follows it.
/// Both the quick-open listing and the snapshot list use the same script
/// shape, so a change in one place cannot silently misparse the other.
fn split_listing(output: &str) -> (String, &str) {
    let mut lines = output.splitn(3, '\n');
    let _sentinel = lines.next();
    let source = lines.next().unwrap_or("find").trim().to_string();
    let body = lines.next().unwrap_or("");
    (source, body)
}

/// The script one run executes. It is kept beside the run so the exact
/// environment prelude and command can be inspected later, independently of
/// the record.
///
/// `executed_from` is the directory the command really runs in: the project
/// root for an archived launch, or this run's code copy for an isolated one.
/// `conda activate` is a shell function rather than a program, so a
/// non-interactive `sh` needs conda's own hook sourced first; no other
/// environment manager is guessed at.
///
/// The environment block runs under `set -e`: a failing `conda activate` or a
/// failed `export` stops the script instead of letting training run against
/// the wrong interpreter. `env_ok` marks the point where preparation
/// succeeded, which is how an observation tells "environment failed" from
/// "training failed".
fn build_command_script(
    executed_from: &str,
    project_root: &str,
    run_dir: &str,
    env: &str,
    gpu: &str,
    command: &str,
) -> String {
    let mut script = String::from("#!/bin/sh\n");
    script.push_str("# generated by EdgeTerm; kept beside the run for reference\n");
    script.push_str(&format!("cd {} || exit 97\n", shell_quote(executed_from)));
    script.push_str(&format!(
        "export EDGETERM_PROJECT_ROOT={}\n",
        shell_quote(project_root)
    ));
    script.push_str(&format!(
        "export EDGETERM_RUN_DIR={}\n",
        shell_quote(run_dir)
    ));
    if env.to_ascii_lowercase().contains("conda activate") {
        script.push_str(
            r#"if command -v conda >/dev/null 2>&1; then
  __et_conda_base=$(conda info --base 2>/dev/null || true)
  if [ -n "$__et_conda_base" ] && [ -f "$__et_conda_base/etc/profile.d/conda.sh" ]; then
    . "$__et_conda_base/etc/profile.d/conda.sh"
  fi
fi
"#,
        );
    }
    if !env.trim().is_empty() {
        script.push_str("set -e\n");
        script.push_str(env);
        if !env.ends_with('\n') {
            script.push('\n');
        }
        script.push_str("set +e\n");
    }
    if !gpu.is_empty() && gpu != "none" && gpu.chars().all(|c| c.is_ascii_digit() || c == ',') {
        script.push_str(&format!(
            "export CUDA_VISIBLE_DEVICES={}\n",
            shell_quote(gpu)
        ));
    }
    script.push_str(&format!(
        "printf 'ready\\n' > {}\n",
        shell_quote(&format!("{run_dir}/env_ok"))
    ));
    script.push_str(command);
    if !command.ends_with('\n') {
        script.push('\n');
    }
    script
}

/// What an observation means. A submission (`sbatch`, `qsub`, `bsub`) that
/// exited cleanly is "submitted", never "finished": the scheduled job is not
/// what this process ran. A process that vanished without an exit code is
/// "lost", and one the user stopped stays stopped.
///
/// A non-zero exit with no `env_ok` marker is an environment failure: the
/// training command never started, and saying "training failed" would send
/// the user looking at the wrong thing.
fn interpret_run(
    exit_code: Option<u32>,
    alive: bool,
    submit_only: bool,
    previous: RunStatus,
    env_ready: bool,
) -> (RunStatus, String) {
    if let Some(code) = exit_code {
        if code == 97 {
            return (
                RunStatus::Failed,
                "the run directory was not available; the command was not run".into(),
            );
        }
        if code != 0 && !env_ready {
            return (
                RunStatus::Failed,
                "the environment setup failed; the training command was not run".into(),
            );
        }
        if submit_only && code == 0 {
            return (
                RunStatus::Submitted,
                "the submission command finished; the scheduled job is not observed here".into(),
            );
        }
        if code == 0 {
            return (RunStatus::Finished, String::new());
        }
        return (RunStatus::Failed, format!("exit code {code}"));
    }
    if alive {
        if submit_only {
            return (RunStatus::Submitted, String::new());
        }
        return (RunStatus::Running, String::new());
    }
    if previous == RunStatus::Stopped {
        return (RunStatus::Stopped, String::new());
    }
    if submit_only {
        return (
            RunStatus::Unknown,
            "the submission process ended without an exit code".into(),
        );
    }
    (
        RunStatus::Lost,
        "the process ended without writing an exit code; the log may explain why".into(),
    )
}

/// Per-file locks for text writes, so two saves of the same path cannot pass
/// the hash check together from separate IPC calls.
#[derive(Default)]
pub struct ProjectOps {
    writing: parking_lot::Mutex<HashSet<String>>,
}

impl ProjectOps {
    fn begin_write(&self, key: String) -> Result<WriteGuard<'_>> {
        let mut writing = self.writing.lock();
        if !writing.insert(key.clone()) {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "a save for this file is already in progress",
            ));
        }
        Ok(WriteGuard {
            ops: self,
            key,
            finished: false,
        })
    }
}

struct WriteGuard<'a> {
    ops: &'a ProjectOps,
    key: String,
    finished: bool,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.ops.writing.lock().remove(&self.key);
        }
    }
}

impl WriteGuard<'_> {
    fn finish(mut self) {
        self.ops.writing.lock().remove(&self.key);
        self.finished = true;
    }
}

fn transport_of(
    state: &crate::commands::AppState,
    id: &str,
) -> Result<(SessionProfile, Arc<SharedTransport>)> {
    let profile = state
        .file_transfers
        .profile_of(id)
        .ok_or_else(|| AppError::new("connect to the server before using this project"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::invalid_input(
            "project work requires an SSH or SFTP session",
        ));
    }
    let transport = state
        .ssh_transports
        .get(id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    Ok((profile, transport))
}

pub fn require_session(
    state: &crate::commands::AppState,
    id: &str,
) -> Result<(SessionProfile, Arc<SharedTransport>)> {
    transport_of(state, id)
}

async fn exec_checked(
    transport: Arc<SharedTransport>,
    script: &str,
    limit: usize,
    timeout: Duration,
) -> Result<ExecStatus> {
    exec::run_status(transport, script, &Control::default(), limit, timeout).await
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn validate_path(path: &str) -> Result<&str> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::invalid_input("the file path is empty"));
    }
    if path.len() > 4096 {
        return Err(AppError::invalid_input("the file path is too long"));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::invalid_input(
            "the file path contains an unsupported character",
        ));
    }
    Ok(path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn eol_of(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let bare_lf = text.matches('\n').count().saturating_sub(crlf);
    let cr = text.matches('\r').count().saturating_sub(crlf);
    if crlf > bare_lf && crlf >= cr {
        "crlf"
    } else if cr > bare_lf && cr > crlf {
        "cr"
    } else {
        "lf"
    }
}

fn apply_eol(content: &str, eol: &str) -> String {
    // Work in LF first: the editor buffer never keeps CR, and a file saved
    // back as CRLF must not end up with doubled carriage returns.
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    match eol {
        "crlf" => normalized.replace('\n', "\r\n"),
        "cr" => normalized.replace('\n', "\r"),
        _ => normalized,
    }
}

/// Relative paths the quick-open list and snapshots keep. `None` means the
/// path belongs to a data tree, a virtual environment or an artifact format.
fn keep_path(path: &str, excludes: &HashSet<String>) -> bool {
    let lowered = path.to_ascii_lowercase();
    let components: Vec<&str> = lowered.split('/').collect();
    let first = components.first().copied().unwrap_or("");
    if TOP_LEVEL_EXCLUDED_DIRS.iter().any(|dir| *dir == first) {
        return false;
    }
    for component in &components {
        if ALWAYS_EXCLUDED_DIRS.iter().any(|dir| *dir == *component) {
            return false;
        }
        if excludes.contains(*component) {
            return false;
        }
    }
    if excludes
        .iter()
        .any(|entry| lowered == *entry || lowered.starts_with(&format!("{entry}/")))
    {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    if TEXT_NAMES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(name))
    {
        return true;
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if extension.is_empty() {
        // No extension: keep small script-ish names only (a binary without
        // an extension is indistinguishable, so it is left out of listings).
        return matches!(
            name.to_ascii_lowercase().as_str(),
            "dockerfile" | "makefile" | "license" | "readme"
        );
    }
    if BINARY_EXTENSIONS.iter().any(|binary| *binary == extension) {
        return false;
    }
    TEXT_EXTENSIONS.iter().any(|text| *text == extension)
}

fn status_of_record(record: &str) -> Option<GitFileChange> {
    let bytes = record.as_bytes();
    if bytes.len() < 4 {
        return None;
    }
    let status = record.get(0..2)?.trim();
    let status = if status.is_empty() { "??" } else { status };
    let path = record.get(3..)?.trim();
    if path.is_empty() {
        return None;
    }
    Some(GitFileChange {
        path: path.to_string(),
        status: status.to_string(),
    })
}

/// Portable subset of `git status --porcelain=v1 -z`: two status characters,
/// a space, then the path. Rename and copy records carry a second NUL field
/// (the original path); it is dropped here because the workbench lists the
/// new path only.
fn parse_status(raw: &str) -> Vec<GitFileChange> {
    let mut files = Vec::new();
    let mut records = raw.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        let Some(change) = status_of_record(record) else {
            continue;
        };
        let rename = change.status.starts_with('R') || change.status.starts_with('C');
        if rename {
            let _ = records.next();
        }
        files.push(change);
    }
    files
}

fn parse_sections(output: &str) -> std::collections::HashMap<&str, &str> {
    let mut sections = std::collections::HashMap::new();
    let mut name: Option<&str> = None;
    let mut start = 0usize;
    for (index, _) in output.match_indices("__ET__:") {
        if let Some(previous) = name {
            let end = index;
            sections.insert(previous, output[start..end].trim_end_matches('\n'));
        }
        let rest = &output[index + 7..];
        let end = rest.find('\n').unwrap_or(rest.len());
        name = Some(&rest[..end]);
        start = index + 7 + end + usize::from(end < rest.len());
    }
    if let Some(previous) = name {
        sections.insert(previous, output[start..].trim_end_matches('\n'));
    }
    sections
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or("").trim().to_string()
}

// --- SFTP ---------------------------------------------------------------

struct Sftp {
    raw: RawSftpSession,
}

impl Sftp {
    async fn open(transport: Arc<SharedTransport>) -> Result<Self> {
        let stream = transport
            .transfer_channel()
            .await
            .map_err(|error| AppError::connection_failed(error.to_string()))?;
        let raw = RawSftpSession::new(stream);
        raw.set_timeout(20);
        raw.init()
            .await
            .map_err(|error| AppError::connection_failed(error.to_string()))?;
        Ok(Self { raw })
    }

    async fn read(
        &self,
        path: &str,
        limit: usize,
    ) -> Result<(Vec<u8>, u64, Option<i64>, Option<u32>)> {
        let before = self
            .raw
            .stat(path)
            .await
            .map_err(|error| AppError::invalid_input(format!("{path}: {error}")))?
            .attrs;
        if before.is_dir() {
            return Err(AppError::invalid_input("select a file, not a directory"));
        }
        let size = before.size.unwrap_or(0);
        if size > limit as u64 {
            return Err(AppError::invalid_input(format!(
                "the file is {size} bytes, above the {limit}-byte editor limit"
            )));
        }
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|error| AppError::invalid_input(format!("{path}: {error}")))?
            .handle;
        let mut bytes = Vec::with_capacity(size as usize);
        while bytes.len() < size as usize {
            let count = (size as usize - bytes.len()).min(64 * 1024) as u32;
            match self.raw.read(&handle, bytes.len() as u64, count).await {
                Ok(data) if !data.data.is_empty() => bytes.extend_from_slice(&data.data),
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == StatusCode::Eof =>
                {
                    break
                }
                Ok(_) => break,
                Err(error) => {
                    let _ = self.raw.close(&handle).await;
                    return Err(AppError::new(format!("reading {path}: {error}")));
                }
            }
        }
        let after = self.raw.fstat(&handle).await.map(|attrs| attrs.attrs).ok();
        let _ = self.raw.close(&handle).await;
        if let Some(after) = after {
            let size_changed = after.size != before.size;
            let mtime_changed =
                after.mtime.is_some() && before.mtime.is_some() && after.mtime != before.mtime;
            if size_changed || mtime_changed {
                return Err(AppError::coded(
                    ErrorCode::Conflict,
                    "the file changed while it was being read; reopen it",
                ));
            }
        }
        Ok((
            bytes,
            size,
            before.mtime.map(|time| time as i64 * 1000),
            before.permissions,
        ))
    }

    async fn write(&self, path: &str, bytes: &[u8], permissions: Option<u32>) -> Result<()> {
        let handle = self
            .raw
            .open(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                FileAttributes {
                    permissions: permissions.map(|mode| mode & 0o777),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| AppError::new(format!("creating {path}: {error}")))?
            .handle;
        let mut offset = 0u64;
        while offset < bytes.len() as u64 {
            let end = (offset as usize + 64 * 1024).min(bytes.len());
            let chunk = bytes[offset as usize..end].to_vec();
            if let Err(error) = self.raw.write(&handle, offset, chunk).await {
                let _ = self.raw.close(&handle).await;
                return Err(AppError::new(format!("writing {path}: {error}")));
            }
            offset = end as u64;
        }
        self.raw
            .close(&handle)
            .await
            .map_err(|error| AppError::new(format!("closing {path}: {error}")))?;
        Ok(())
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

async fn sftp_for(transport: Arc<SharedTransport>) -> Result<Sftp> {
    tokio::time::timeout(Duration::from_secs(20), Sftp::open(transport))
        .await
        .map_err(|_| AppError::timeout("opening the SFTP channel timed out"))?
}

// --- commands -----------------------------------------------------------

pub async fn probe(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
) -> Result<ProjectProbe> {
    let root = validate_path(root)?;
    let (_, transport) = transport_of(state, id)?;
    let quoted = shell_quote(root);
    let script = format!(
        r#"printf '__ET__:os\n'; uname -srm 2>/dev/null
printf '__ET__:home\n'; printf '%s\n' "$HOME"
printf '__ET__:shell\n'; printf '%s\n' "$SHELL"
printf '__ET__:git\n'; command -v git 2>/dev/null
printf '__ET__:tmux\n'; command -v tmux 2>/dev/null
printf '__ET__:python\n'; command -v python3 2>/dev/null || command -v python 2>/dev/null
printf '__ET__:conda\n'; command -v conda 2>/dev/null
printf '__ET__:nvidia\n'; command -v nvidia-smi 2>/dev/null
printf '__ET__:scheduler\n'; for c in sbatch qsub bsub srun; do p=$(command -v "$c" 2>/dev/null) && {{ printf '%s\n' "$c"; break; }}; done
printf '__ET__:root\n'; if [ -d {quoted} ]; then printf 'yes\n'; else printf 'no\n'; fi
printf '__ET__:repo\n'; if git -C {quoted} rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'yes\n'; else printf 'no\n'; fi
"#
    );
    let output = exec_checked(transport, &script, 64 * 1024, COMMAND_TIMEOUT).await?;
    let sections = parse_sections(&output.stdout);
    let path = |name: &str| {
        let value = sections.get(name).copied().unwrap_or("");
        let line = first_line(value);
        (!line.is_empty()).then_some(line)
    };
    let mut paths = Vec::new();
    for name in ["git", "tmux", "python", "conda", "nvidia"] {
        if let Some(found) = path(name) {
            paths.push(format!("{name}: {found}"));
        }
    }
    Ok(ProjectProbe {
        os: first_line(sections.get("os").copied().unwrap_or("")),
        home: first_line(sections.get("home").copied().unwrap_or("")),
        shell: first_line(sections.get("shell").copied().unwrap_or("")),
        git: path("git").is_some(),
        tmux: path("tmux").is_some(),
        python: path("python"),
        conda: path("conda").is_some(),
        nvidia_smi: path("nvidia").is_some(),
        scheduler: path("scheduler"),
        is_repository: first_line(sections.get("repo").copied().unwrap_or("")) == "yes",
        root_exists: first_line(sections.get("root").copied().unwrap_or("")) == "yes",
        paths,
    })
}

pub async fn read_text(
    state: &crate::commands::AppState,
    id: &str,
    path: &str,
) -> Result<TextFile> {
    let path = validate_path(path)?;
    let (profile, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;
    let (bytes, size, modified_at, permissions) = sftp.read(path, TEXT_LIMIT).await?;
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let content = &bytes[if bom { 3 } else { 0 }..];
    if content.contains(&0) {
        return Err(AppError::invalid_input(
            "the file looks binary; the built-in editor only opens text",
        ));
    }
    let decoded = match std::str::from_utf8(content) {
        Ok(text) => (text.to_string(), "UTF-8".to_string()),
        Err(_) => {
            let fallback = profile
                .encoding
                .as_deref()
                .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()));
            let Some(encoding) = fallback else {
                return Err(AppError::invalid_input(
                    "the file is not valid UTF-8; set the session encoding or edit it externally",
                ));
            };
            let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(content)
            else {
                return Err(AppError::invalid_input(
                    "the file cannot be decoded with the session's encoding",
                ));
            };
            (text.into_owned(), encoding.name().to_string())
        }
    };
    Ok(TextFile {
        path: path.to_string(),
        eol: eol_of(&decoded.0).to_string(),
        content: decoded.0,
        encoding: decoded.1,
        hash: sha256_hex(&bytes),
        size,
        bom,
        modified_at,
        permissions,
    })
}

/// A save is serialized per *file*, not per session: two sessions logged in
/// as the same user on the same host write the same file, so the key is the
/// connection identity plus the canonical path. Using the tab id here would
/// let two windows (or two sessions to one host) pass the hash check at the
/// same time and replace each other's content.
fn write_lock_key(profile: &SessionProfile, target: &str) -> String {
    format!(
        "{}@{}:{}::{}",
        profile.username.clone().unwrap_or_default(),
        profile.host.clone().unwrap_or_default(),
        profile.port.unwrap_or(22),
        target
    )
}

/// Textual normalization for lock keys and messages: collapse repeated and
/// trailing slashes and resolve `.`/`..` segments. The server side
/// `realpath` of the parent directory is preferred; this is the fallback when
/// it cannot be asked.
fn normalize_remote_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

/// The path the write actually targets. The parent directory is resolved on
/// the server, so a file reached through a symlinked directory gets the same
/// lock key and the same reported path as one reached directly. The file name
/// itself is not resolved when the file does not exist yet.
async fn canonical_target(sftp: &Sftp, path: &str) -> String {
    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) if !name.is_empty() => {
            (if parent.is_empty() { "/" } else { parent }, name)
        }
        _ => return normalize_remote_path(path),
    };
    match sftp.raw.realpath(parent).await {
        Ok(response) => match response.files.first() {
            Some(file) => {
                let dir = file.filename.trim_end_matches('/');
                if dir.is_empty() {
                    format!("/{name}")
                } else {
                    format!("{dir}/{name}")
                }
            }
            None => normalize_remote_path(path),
        },
        Err(_) => normalize_remote_path(path),
    }
}

pub async fn write_text(
    state: &crate::commands::AppState,
    ops: &ProjectOps,
    id: &str,
    request: TextWrite,
) -> Result<WriteOutcome> {
    let requested = validate_path(&request.path)?.to_string();
    let (profile, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;

    // Resolve before locking so two spellings of one file share a key.
    let path = canonical_target(&sftp, &requested).await;
    let guard = ops.begin_write(write_lock_key(&profile, &path))?;

    // Only "no such file" means this is a new file. A permission or transport
    // error must not be read as absence and then overwrite the target.
    let existing = match sftp.raw.stat(&path).await {
        Ok(_) => Some(sftp.read(&path, TEXT_LIMIT).await?.0),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            None
        }
        Err(error) => return Err(AppError::new(format!("{path}: {error}"))),
    };
    let current_hash = existing.as_deref().map(sha256_hex);
    match (&request.expected_hash, &current_hash) {
        _ if request.force => {}
        (Some(expected), Some(actual)) if expected != actual => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the file changed on the server since it was opened; reload or overwrite explicitly",
            ));
        }
        (Some(_), None) => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the file was removed on the server since it was opened",
            ));
        }
        (None, Some(_)) => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "a file already exists at this path",
            ));
        }
        _ => {}
    }

    let text = apply_eol(&request.content, &request.eol);
    let encoding = request
        .encoding
        .as_deref()
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (encoded, _, had_errors) = encoding.encode(&text);
    if had_errors {
        return Err(AppError::invalid_input(format!(
            "some characters cannot be written as {}; change the file encoding or the text",
            encoding.name()
        )));
    }
    let mut bytes = Vec::new();
    if request.bom && encoding == encoding_rs::UTF_8 {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(&encoded);
    let hash = sha256_hex(&bytes);
    let size = bytes.len() as u64;

    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) if !name.is_empty() => (parent, name),
        _ => return Err(AppError::invalid_input("the file needs a parent directory")),
    };
    // Hidden siblings with a random suffix: two saves of similarly named
    // files in one directory cannot collide, and a leftover file says what it
    // belongs to and which save produced it.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let nonce = &nonce[..12];
    let temp = format!("{parent}/.{name}.edgeterm-{nonce}.tmp");
    let backup = format!("{parent}/.{name}.edgeterm-{nonce}.bak");
    let permissions = sftp
        .raw
        .stat(&path)
        .await
        .ok()
        .and_then(|entry| entry.attrs.permissions);

    // A copy of the previous content, written from the bytes already read.
    // It is removed once the replace is confirmed; on any failure it stays
    // beside the file and its path is reported.
    if let Some(previous) = &existing {
        if let Err(error) = sftp.write(&backup, previous, permissions).await {
            return Err(AppError::new(format!(
                "the previous content could not be kept at {backup}: {error}"
            )));
        }
    }
    if let Err(error) = sftp.write(&temp, &bytes, permissions).await {
        let _ = sftp.raw.remove(&temp).await;
        if existing.is_some() {
            let _ = sftp.raw.remove(&backup).await;
        }
        return Err(error);
    }

    // Re-read the target immediately before replacing it. This narrows the
    // gap between the hash check and the rename to one round trip, and it is
    // what makes two EdgeTerm saves of one file safe. It is *not* a
    // conditional rename: a program writing between this read and the rename
    // below still wins, because SFTP has no compare-and-swap and POSIX rename
    // is atomic but unconditional.
    let now = match sftp.raw.stat(&path).await {
        Ok(_) => Some(sftp.read(&path, TEXT_LIMIT).await?.0),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            None
        }
        Err(error) => {
            let _ = sftp.raw.remove(&temp).await;
            return Err(AppError::coded(
                ErrorCode::RemoteWriteUncertain,
                format!(
                    "the target could not be re-read before replacing it ({error}); \
                     the new content is at {temp} and the previous content at {backup}"
                ),
            ));
        }
    };
    if now.as_deref().map(sha256_hex) != current_hash {
        let _ = sftp.raw.remove(&temp).await;
        if existing.is_some() {
            let _ = sftp.raw.remove(&backup).await;
        }
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "the file changed while it was being saved; nothing was replaced, reopen it",
        ));
    }

    if let Err(error) = sftp.raw.rename(&temp, &path).await {
        // Both files stay: the caller needs the new bytes (temp) and the old
        // ones (backup) to decide what to do.
        return Err(AppError::coded(
            ErrorCode::RemoteWriteUncertain,
            format!(
                "{path} could not be replaced ({error}); the new content is at {temp} \
                 and the previous content at {backup}"
            ),
        ));
    }

    // The rename is done. Confirm the size, then retire the backup.
    let verified = match sftp.raw.stat(&path).await {
        Ok(entry) => entry.attrs.size == Some(size),
        Err(_) => false,
    };
    if !verified {
        guard.finish();
        return Ok(WriteOutcome {
            path,
            hash,
            size,
            backup: existing.as_ref().map(|_| backup),
            temp: None,
            uncertain: true,
            note: "the replace went through, but the new size could not be confirmed; reload before editing again"
                .into(),
        });
    }
    if existing.is_some() {
        let _ = sftp.raw.remove(&backup).await;
    }
    guard.finish();
    Ok(WriteOutcome {
        path,
        hash,
        size,
        backup: None,
        temp: None,
        uncertain: false,
        note: String::new(),
    })
}

pub async fn stat_file(
    state: &crate::commands::AppState,
    id: &str,
    path: &str,
) -> Result<FileStat> {
    let path = validate_path(path)?;
    let (_, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;
    match sftp.raw.stat(path).await {
        Ok(entry) => Ok(FileStat {
            path: path.to_string(),
            exists: true,
            size: entry.attrs.size.unwrap_or(0),
            modified_at: entry.attrs.mtime.map(|time| time as i64 * 1000),
        }),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(FileStat {
                path: path.to_string(),
                exists: false,
                size: 0,
                modified_at: None,
            })
        }
        Err(error) => Err(AppError::new(format!("{path}: {error}"))),
    }
}

pub async fn list_files(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
) -> Result<FileList> {
    let root = validate_path(root)?;
    let (_, transport) = transport_of(state, id)?;
    let quoted = shell_quote(root);
    let script = format!(
        r#"cd {quoted} || exit 2
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  printf '__ET__:source\ngit\n'
  git ls-files -z --cached --others --exclude-standard
else
  printf '__ET__:source\nfind\n'
  find . -type f -print0 2>/dev/null
fi
"#
    );
    let output = exec_checked(transport, &script, LIST_LIMIT, COMMAND_TIMEOUT).await?;
    if output.exit_code.unwrap_or(0) != 0 {
        return Err(AppError::invalid_input(format!(
            "cannot list {}: {}",
            root,
            first_line(&output.stderr)
        )));
    }
    let (source, body) = split_listing(&output.stdout);
    let excludes = HashSet::new();
    let mut files = Vec::new();
    let mut truncated = output.truncated;
    for relative in body.split('\0') {
        let relative = relative.trim_start_matches("./");
        if relative.is_empty() || !keep_path(relative, &excludes) {
            continue;
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        files.push(relative.to_string());
    }
    files.sort();
    Ok(FileList {
        root: root.to_string(),
        files,
        truncated,
        source,
    })
}

/// One search hit. GNU `grep -Z` prints `path\0line:text`, while `git grep
/// -z` prints `path\0line\0text`; both are accepted so the same parser
/// serves repositories and plain directories.
fn parse_search_record(record: &str) -> Option<(&str, u32, &str)> {
    let (path, rest) = record.split_once('\0')?;
    let (line, text) = match rest.split_once('\0') {
        Some(pair) => pair,
        None => rest.split_once(':')?,
    };
    let line = line.trim().parse::<u32>().ok()?;
    Some((path, line, text))
}

pub async fn search(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
    query: &str,
) -> Result<SearchResult> {
    let root = validate_path(root)?;
    if query.trim().is_empty() {
        return Err(AppError::invalid_input("enter something to search for"));
    }
    if query.len() > 400 {
        return Err(AppError::invalid_input("the search text is too long"));
    }
    let (_, transport) = transport_of(state, id)?;
    let quoted_root = shell_quote(root);
    let quoted_query = shell_quote(query);
    let mut prune_parts = Vec::new();
    for dir in ALWAYS_EXCLUDED_DIRS {
        prune_parts.push(format!("-name {}", shell_quote(dir)));
    }
    for dir in TOP_LEVEL_EXCLUDED_DIRS {
        prune_parts.push(format!("-path {}", shell_quote(&format!("./{dir}"))));
    }
    let prune = prune_parts.join(" -o ");
    let script = format!(
        r#"cd {quoted_root} || exit 2
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  git grep --untracked -n -I -m 3 -F -z -e {quoted_query} -- .
else
  find . \( {prune}-false \) -prune -o -type f -print0 2>/dev/null |
    xargs -0 grep -nIZ -F -m 3 --binary-files=without-match -e {quoted_query} -- 2>/dev/null
fi
"#
    );
    let output = exec_checked(transport, &script, 512 * 1024, COMMAND_TIMEOUT).await?;
    let exit = output.exit_code.unwrap_or(0);
    // grep uses 1 for "no matches"; anything else is a real failure.
    if exit != 0 && exit != 1 {
        return Err(AppError::new(format!(
            "the server could not search this project (exit {exit}): {}",
            first_line(&output.stderr)
        )));
    }
    let mut matches = Vec::new();
    let mut truncated = output.truncated;
    for record in output.stdout.split('\n') {
        let Some((path, line, text)) = parse_search_record(record) else {
            continue;
        };
        if matches.len() >= MAX_SEARCH_MATCHES {
            truncated = true;
            break;
        }
        let path = path.trim_start_matches("./");
        if !keep_path(path, &HashSet::new()) {
            continue;
        }
        matches.push(SearchMatch {
            path: path.to_string(),
            line,
            text: text.chars().take(400).collect(),
        });
    }
    Ok(SearchResult {
        root: root.to_string(),
        query: query.to_string(),
        matches,
        truncated,
        skipped: "git history, binary files and data directories are not searched".into(),
    })
}

pub async fn git_state(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
) -> Result<GitState> {
    let root = validate_path(root)?;
    let (_, transport) = transport_of(state, id)?;
    let quoted = shell_quote(root);
    let script = format!(
        r#"cd {quoted} || exit 2
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '__ET__:repo\nno\n'; exit 0; fi
printf '__ET__:repo\nyes\n'
printf '__ET__:branch\n'; git rev-parse --abbrev-ref HEAD 2>/dev/null
printf '__ET__:commit\n'; git rev-parse HEAD 2>/dev/null
printf '__ET__:status\n'; git status --porcelain=v1 -z 2>/dev/null
printf '__ET__:diff\n'
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git diff HEAD --no-color --no-ext-diff --no-renames 2>/dev/null
else
  git diff --no-color --no-ext-diff --no-renames 2>/dev/null
fi
"#
    );
    let output = exec_checked(transport, &script, DIFF_LIMIT + 128 * 1024, COMMAND_TIMEOUT).await?;
    let sections = parse_sections(&output.stdout);
    if first_line(sections.get("repo").copied().unwrap_or("")) != "yes" {
        return Ok(GitState {
            is_repository: false,
            branch: String::new(),
            commit: String::new(),
            dirty: false,
            files: Vec::new(),
            diff_sha256: String::new(),
            diff_bytes: 0,
            diff_truncated: false,
            note: "not a git repository; files remain editable and comparable".into(),
        });
    }
    let files = parse_status(sections.get("status").copied().unwrap_or(""));
    let diff = sections.get("diff").copied().unwrap_or("");
    Ok(GitState {
        is_repository: true,
        branch: first_line(sections.get("branch").copied().unwrap_or("")),
        commit: first_line(sections.get("commit").copied().unwrap_or("")),
        dirty: !files.is_empty(),
        files,
        diff_sha256: sha256_hex(diff.as_bytes()),
        diff_bytes: diff.len() as u64,
        diff_truncated: output.truncated,
        note: String::new(),
    })
}

pub async fn git_diff(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
    path: Option<&str>,
) -> Result<DiffText> {
    let root = validate_path(root)?;
    let (_, transport) = transport_of(state, id)?;
    let quoted = shell_quote(root);
    let filter = path
        .map(|path| format!(" -- {}", shell_quote(validate_path(path).unwrap_or(path))))
        .unwrap_or_default();
    let script = format!(
        r#"cd {quoted} || exit 2
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git diff HEAD --no-color --no-ext-diff --no-renames{filter} 2>/dev/null
else
  git diff --no-color --no-ext-diff --no-renames{filter} 2>/dev/null
fi
"#
    );
    let output = exec_checked(transport, &script, DIFF_LIMIT, COMMAND_TIMEOUT).await?;
    Ok(DiffText {
        bytes: output.stdout.len() as u64,
        text: output.stdout,
        truncated: output.truncated,
    })
}

pub async fn read_log(
    state: &crate::commands::AppState,
    id: &str,
    path: &str,
    offset: u64,
) -> Result<LogChunk> {
    let path = validate_path(path)?;
    let (_, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;
    let attrs = match sftp.raw.stat(path).await {
        Ok(entry) => entry.attrs,
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            return Ok(LogChunk {
                path: path.to_string(),
                content: String::new(),
                offset: 0,
                size: 0,
                reset: offset != 0,
                exists: false,
            })
        }
        Err(error) => return Err(AppError::new(format!("{path}: {error}"))),
    };
    let size = attrs.size.unwrap_or(0);
    let reset = offset == 0 || offset > size;
    let start = if reset {
        size.saturating_sub(LOG_TAIL)
    } else {
        offset
    };
    let take = (size - start).min(LOG_CHUNK);
    let handle = sftp
        .raw
        .open(path, OpenFlags::READ, FileAttributes::empty())
        .await
        .map_err(|error| AppError::new(format!("{path}: {error}")))?
        .handle;
    let mut bytes = Vec::with_capacity(take as usize);
    while (bytes.len() as u64) < take {
        let count = (take - bytes.len() as u64).min(64 * 1024) as u32;
        match sftp
            .raw
            .read(&handle, start + bytes.len() as u64, count)
            .await
        {
            Ok(data) if !data.data.is_empty() => bytes.extend_from_slice(&data.data),
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::Eof =>
            {
                break
            }
            Ok(_) => break,
            Err(error) => {
                let _ = sftp.raw.close(&handle).await;
                return Err(AppError::new(format!("reading {path}: {error}")));
            }
        }
    }
    let _ = sftp.raw.close(&handle).await;
    Ok(LogChunk {
        path: path.to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        offset: start + bytes.len() as u64,
        size,
        reset,
        exists: true,
    })
}

pub async fn compare(
    state: &crate::commands::AppState,
    left_id: &str,
    left_path: &str,
    right_id: &str,
    right_path: &str,
) -> Result<Comparison> {
    let left_path = validate_path(left_path)?.to_string();
    let right_path = validate_path(right_path)?.to_string();
    let (left_profile, left_transport) = transport_of(state, left_id)?;
    let (_, right_transport) = transport_of(state, right_id)?;
    crate::file_diff::compare_remote(
        left_transport,
        left_path,
        right_transport,
        right_path,
        left_profile.encoding,
    )
    .await
}

// --- runs ---------------------------------------------------------------

fn task_name(run_id: &str) -> String {
    let suffix: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(24)
        .collect();
    format!("et-{suffix}")
}

/// The scheduler a launch command belongs to, and whether the command only
/// submits work. `srun` runs in the foreground, so a tmux session around it
/// still reports the real exit status; `sbatch`, `qsub` and `bsub` return
/// after handing the job off.
fn scheduler_for(command: &str, available: Option<&str>) -> Option<(String, bool)> {
    let first = command
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    let (name, submits) = match first {
        "sbatch" => ("slurm", true),
        "srun" => ("slurm", false),
        "qsub" => ("pbs", true),
        "bsub" => ("lsf", true),
        _ => return None,
    };
    available
        .is_some_and(|available| available == name)
        .then(|| (name.to_string(), submits))
}

fn default_run_dir(root: &str, run_root: &str, run_id: &str) -> String {
    let base = if run_root.trim().is_empty() {
        format!("{}/.edgeterm/runs", root.trim_end_matches('/'))
    } else {
        run_root.trim_end_matches('/').to_string()
    };
    format!("{base}/{run_id}")
}

fn snapshot_excludes(root: &str, run_dir: &str, extra: &[String]) -> HashSet<String> {
    let mut excludes: HashSet<String> = ALWAYS_EXCLUDED_DIRS
        .iter()
        .map(|dir| dir.to_string())
        .collect();
    for entry in extra {
        let entry = entry.trim().trim_matches('/');
        if entry.is_empty() {
            continue;
        }
        for component in entry.split('/') {
            excludes.insert(component.to_ascii_lowercase());
        }
    }
    // The run directory is inside the project by default; copying it into
    // its own snapshot would recurse forever.
    excludes.insert(".edgeterm".into());
    // A custom run directory inside the project must not copy itself into
    // its own snapshot. Its first path component is enough: excluding the
    // whole tree keeps the copy finite.
    let prefix = format!("{}/", root.trim_end_matches('/'));
    if let Some(relative) = run_dir.strip_prefix(&prefix) {
        if let Some(first) = relative.split('/').next().filter(|part| !part.is_empty()) {
            excludes.insert(first.to_ascii_lowercase());
        }
    }
    excludes
}

fn snapshot_list_script(root: &str) -> String {
    let quoted = shell_quote(root);
    format!(
        r#"cd {quoted} || exit 2
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  printf '__ET__:source\ngit\n'
  git ls-files -z --cached --others --exclude-standard
else
  printf '__ET__:source\nfind\n'
  find . -type f -print0 2>/dev/null
fi
"#
    )
}

/// A link into an isolated copy is a project-relative path. Absolute paths,
/// `..` and empty segments are refused: the link is created by a shell
/// command, and a path that can leave the project is not something a launch
/// dialog should be able to express.
fn validate_link(link: &str) -> Result<String> {
    let trimmed = link.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::invalid_input("a linked path is empty"));
    }
    if trimmed.starts_with('/') {
        return Err(AppError::invalid_input(
            "linked paths are relative to the project root",
        ));
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(AppError::invalid_input(format!(
            "{trimmed} is not a plain project-relative path"
        )));
    }
    if trimmed.contains('\0') || trimmed.contains('\n') {
        return Err(AppError::invalid_input(
            "the linked path contains an unsupported character",
        ));
    }
    Ok(trimmed.to_string())
}

/// Symlinks the requested data and weight directories into an isolated copy.
/// A failure is fatal: a run that cannot see its data is not the run the user
/// confirmed, and quietly falling back to the project directory would make
/// the isolation claim false.
async fn link_project_dirs(
    transport: Arc<SharedTransport>,
    root: &str,
    code_dir: &str,
    links: &[String],
    warnings: &mut Vec<String>,
) -> Result<()> {
    if links.is_empty() {
        warnings.push(
            "this isolated run has no linked data directories; relative data paths inside the copy will not resolve"
                .into(),
        );
        return Ok(());
    }
    let mut script = String::new();
    for link in links {
        let target = format!("{root}/{link}");
        let into = format!("{code_dir}/{link}");
        script.push_str(&format!(
            "if [ ! -e {target} ]; then printf 'missing %s\\n' {link}; exit 11; fi\n\
             mkdir -p \"$(dirname {into})\" || exit 12\n\
             if [ -e {into} ]; then printf 'already in the copy %s\\n' {link}; exit 13; fi\n\
             ln -s {target} {into} || exit 14\n\
             [ -e {into} ] || {{ printf 'link did not resolve %s\\n' {link}; exit 15; }}\n",
            target = shell_quote(&target),
            into = shell_quote(&into),
            link = shell_quote(link),
        ));
    }
    script.push_str("exit 0\n");
    let output = exec_checked(transport, &script, 4096, Duration::from_secs(20)).await?;
    if output.exit_code.unwrap_or(1) != 0 {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            format!(
                "the isolated copy could not be linked to the project data: {}",
                first_line(&output.stdout)
            ),
        ));
    }
    Ok(())
}

pub async fn start_run(
    state: &crate::commands::AppState,
    id: &str,
    request: StartRunRequest,
) -> Result<RunLaunch> {
    let root = validate_path(&request.run.root)?.to_string();
    if request.run.command.trim().is_empty() {
        return Err(AppError::invalid_input("enter a command to run"));
    }
    if request.execution == ExecutionMode::Isolated && request.snapshot != SnapshotMode::Code {
        return Err(AppError::invalid_input(
            "an isolated run needs a code snapshot; enable the snapshot or run in the project directory",
        ));
    }
    // The editor's unsaved buffers are not on the server, so a run would
    // execute the previous version of those files. Refusing by default is the
    // only way not to launch something the user did not confirm.
    if request.require_clean && !request.unsynced.is_empty() {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            format!(
                "{} file(s) still have unsaved edits; save them, or confirm that the run uses the remote copies",
                request.unsynced.len()
            ),
        ));
    }
    let links = request
        .links
        .iter()
        .map(|link| validate_link(link))
        .collect::<Result<Vec<_>>>()?;
    // A run id is a launch: reusing one would make two launches share a
    // directory, a task name and a log.
    if state
        .workspaces
        .snapshot()
        .runs
        .iter()
        .any(|run| run.id == request.run.id)
    {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "a run with this id already exists; open it instead of launching it again",
        ));
    }
    let (profile, transport) = transport_of(state, id)?;
    let same_login = request.run.server.profile_id == profile.id
        || (request.run.server.host == profile.host.clone().unwrap_or_default()
            && request.run.server.port == profile.port.unwrap_or(22)
            && request.run.server.username == profile.username.clone().unwrap_or_default());
    if !same_login {
        return Err(AppError::invalid_input(
            "the run record names a different server than this session",
        ));
    }
    let probe = probe(state, id, &root).await?;
    if !probe.root_exists {
        return Err(AppError::invalid_input(format!(
            "the project directory {root} does not exist on this server"
        )));
    }
    let run_dir = if request.run.run_dir.trim().is_empty() {
        default_run_dir(&root, &request.run_root, &request.run.id)
    } else {
        validate_path(&request.run.run_dir)?.to_string()
    };
    let log_path = format!("{run_dir}/run.log");
    let name = task_name(&request.run.id);
    let scheduler = scheduler_for(&request.run.command, probe.scheduler.as_deref());
    let submit_only = scheduler.as_ref().is_some_and(|(_, submits)| *submits);
    let mode = if probe.tmux {
        RunMode::Tmux
    } else {
        RunMode::Detached
    };
    let mut warnings = Vec::new();
    if !probe.tmux {
        warnings.push(
            "tmux is not installed; this run is detached and cannot be attached interactively"
                .into(),
        );
    }
    if submit_only {
        warnings.push(
            "the command submits a job; the run records the submission, not the training job"
                .into(),
        );
    }

    // The task name is derived from the run id, so a retry of the same record
    // cannot start a second copy silently.
    // Either a tmux session or a live detached pid means this run id is
    // already executing; a retry must reattach or stop it, never start a
    // second copy.
    let check = exec_checked(
        transport.clone(),
        &format!(
            "d={}; if command -v tmux >/dev/null 2>&1 && tmux has-session -t {} 2>/dev/null; then printf 'alive'; elif [ -f \"$d/pid\" ] && kill -0 \"$(head -c 32 \"$d/pid\")\" 2>/dev/null; then printf 'alive'; fi",
            shell_quote(&run_dir),
            shell_quote(&name)
        ),
        128,
        Duration::from_secs(5),
    )
    .await?;
    if check.stdout.trim() == "alive" {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "a launch with this run id is already alive; reattach or stop it instead of starting again",
        ));
    }

    let code = capture_code(state, id, &root).await?;

    let create = exec_checked(
        transport.clone(),
        &format!(
            "mkdir -p -- {}{}",
            shell_quote(&run_dir),
            if request.snapshot == SnapshotMode::Code {
                " ".to_string() + &shell_quote(&format!("{run_dir}/code"))
            } else {
                String::new()
            }
        ),
        1024,
        Duration::from_secs(10),
    )
    .await?;
    if create.exit_code.unwrap_or(0) != 0 {
        return Err(AppError::new(format!(
            "cannot create {run_dir}: {}",
            first_line(&create.stderr)
        )));
    }

    let mut snapshot = RunSnapshot {
        mode: SnapshotMode::None,
        ..Default::default()
    };
    if request.snapshot == SnapshotMode::Code {
        snapshot =
            capture_snapshot(state, id, &root, &run_dir, &request.excludes, &mut warnings).await?;
    }
    if request.execution == ExecutionMode::Isolated && !snapshot.verified {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            format!(
                "the code copy for this run is not complete ({}); no isolated launch was started",
                snapshot.note
            ),
        ));
    }
    let executed_from = if request.execution == ExecutionMode::Isolated {
        snapshot.path.clone()
    } else {
        root.clone()
    };
    if request.execution == ExecutionMode::Isolated {
        link_project_dirs(
            transport.clone(),
            &root,
            &executed_from,
            &links,
            &mut warnings,
        )
        .await?;
    }

    let binding = RunBinding {
        execution: request.execution,
        executed_from: executed_from.clone(),
        workspace_root: root.clone(),
        isolated: request.execution == ExecutionMode::Isolated,
        snapshot_verified: snapshot.verified,
        unsynced: request.unsynced.clone(),
        links: links.clone(),
        note: match (request.execution, snapshot.mode) {
            (ExecutionMode::Isolated, _) => {
                "runs in the code copy made for this run; absolute paths still point at the project root, and compiled artifacts are not copied"
                    .into()
            }
            (ExecutionMode::Workspace, SnapshotMode::Code) => {
                "runs in the project directory; the code copy beside it records what was there at launch"
                    .into()
            }
            _ => "runs in the project directory; no code copy was kept".into(),
        },
    };

    let command = build_command_script(
        &executed_from,
        &root,
        &run_dir,
        request.run.env.trim(),
        request.run.gpu.trim(),
        &request.run.command,
    );

    let launch = format!(
        r#"#!/bin/sh
# generated by EdgeTerm
cd {} || exit 97
# A directory reused by an earlier launch must not report its exit code or
# its environment marker as this run's.
rm -f exit_code ended_at env_ok
printf 'running\n' > state
date +%s > started_at
if command -v bash >/dev/null 2>&1; then
  bash ./command.sh > run.log 2>&1
else
  sh ./command.sh > run.log 2>&1
fi
code=$?
printf '%s\n' "$code" > exit_code
date +%s > ended_at
printf '%s\n' "$code" > state
exit "$code"
"#,
        shell_quote(&run_dir)
    );

    let sftp = sftp_for(transport.clone()).await?;
    sftp.write(
        &format!("{run_dir}/command.sh"),
        command.as_bytes(),
        Some(0o755),
    )
    .await?;
    sftp.write(
        &format!("{run_dir}/launch.sh"),
        launch.as_bytes(),
        Some(0o755),
    )
    .await?;

    let mut run = request.run.clone();
    run.run_dir = run_dir.clone();
    run.log_path = log_path.clone();
    run.task_name = name.clone();
    run.mode = mode;
    run.code = code;
    run.snapshot = snapshot;
    run.binding = binding;
    run.status = RunStatus::Starting;
    run.scheduler = scheduler.as_ref().map(|(name, _)| name.clone());
    run.submit_only = submit_only;
    run.started_at = now_ms();
    run.last_seen_at = run.started_at;
    run.ended_at = None;
    run.exit_code = None;

    let manifest = serde_json::json!({
        "runId": run.id,
        "execution": run.binding.execution,
        "executedFrom": run.binding.executed_from,
        "workspaceRoot": run.binding.workspace_root,
        "unsynced": run.binding.unsynced,
        "links": run.binding.links,
        "command": run.command,
        "env": run.env,
        "gpu": run.gpu,
        "scheduler": run.scheduler,
        "runDir": run.run_dir,
        "logPath": run.log_path,
        "code": run.code,
        "snapshot": run.snapshot,
        "tools": {
            "conda": probe.conda,
            "tmux": probe.tmux,
            "python": probe.python,
            "nvidiaSmi": probe.nvidia_smi,
        },
        "note": "recorded at launch; this is not a claim that the run can be reproduced",
    });
    let meta = serde_json::to_string_pretty(&run)?;
    sftp.write(
        &format!("{run_dir}/meta.json"),
        meta.as_bytes(),
        Some(0o644),
    )
    .await?;
    sftp.write(
        &format!("{run_dir}/manifest.json"),
        serde_json::to_string_pretty(&manifest)?.as_bytes(),
        Some(0o644),
    )
    .await?;
    drop(sftp);

    // Record before launching. If the record cannot be written the launch is
    // not attempted: an unrecorded process is one the user cannot find again.
    state.workspaces.record_run(run.clone())?;

    let start = match mode {
        RunMode::Tmux => {
            format!(
                "tmux new-session -d -s {} -c {} {}",
                shell_quote(&name),
                shell_quote(&run_dir),
                shell_quote("sh launch.sh")
            )
        }
        RunMode::Detached => format!(
            "cd {} && (setsid sh launch.sh >/dev/null 2>&1 < /dev/null & echo $! > pid) 2>/dev/null || (nohup sh launch.sh >/dev/null 2>&1 < /dev/null & echo $! > pid)",
            shell_quote(&run_dir)
        ),
        RunMode::Terminal => {
            return Err(AppError::invalid_input(
                "terminal launches are opened by the UI, not this command",
            ))
        }
    };
    let mut uncertain = false;
    match exec_checked(transport, &start, 4096, Duration::from_secs(15)).await {
        Ok(output) if output.exit_code.unwrap_or(1) == 0 => {
            run.status = if submit_only {
                RunStatus::Submitted
            } else {
                RunStatus::Running
            };
            run.last_seen_at = now_ms();
        }
        Ok(output) => {
            let message = first_line(&output.stderr);
            run.status = RunStatus::Failed;
            run.ended_at = Some(now_ms());
            run.last_seen_at = run.ended_at.unwrap_or_else(now_ms);
            run.note = if message.is_empty() {
                "the launcher returned an error".into()
            } else {
                message.clone()
            };
            warnings.push(format!(
                "the run did not start: {}",
                if message.is_empty() {
                    "the launcher returned an error"
                } else {
                    message.as_str()
                }
            ));
        }
        Err(error) => {
            // The command may have started before the channel broke. Keep the
            // record and let an observation decide, instead of reporting a
            // failure that would invite a second launch.
            uncertain = true;
            run.status = RunStatus::Unknown;
            run.last_seen_at = now_ms();
            warnings.push(format!(
                "the launch result could not be read ({error}); the run is recorded as unknown, refresh it before starting another"
            ));
        }
    }
    let saved = state.workspaces.record_run(run.clone()).unwrap_or(run);
    Ok(RunLaunch {
        run: saved,
        warnings,
        uncertain,
    })
}

async fn capture_code(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
) -> Result<RunCodeState> {
    let git = git_state(state, id, root).await?;
    if !git.is_repository {
        return Ok(RunCodeState {
            is_repository: false,
            ..Default::default()
        });
    }
    Ok(RunCodeState {
        branch: git.branch,
        commit: git.commit,
        dirty: git.dirty,
        dirty_files: git.files.iter().map(|file| file.path.clone()).collect(),
        diff_sha256: git.diff_sha256,
        diff_bytes: git.diff_bytes,
        diff_truncated: git.diff_truncated,
        is_repository: true,
    })
}

async fn capture_snapshot(
    state: &crate::commands::AppState,
    id: &str,
    root: &str,
    run_dir: &str,
    extra_excludes: &[String],
    warnings: &mut Vec<String>,
) -> Result<RunSnapshot> {
    let (_, transport) = transport_of(state, id)?;
    let excludes = snapshot_excludes(root, run_dir, extra_excludes);
    let list = exec_checked(
        transport.clone(),
        &snapshot_list_script(root),
        2 * 1024 * 1024,
        COMMAND_TIMEOUT,
    )
    .await?;
    let (_source, body) = split_listing(&list.stdout);
    let mut files = Vec::new();
    let mut skipped = 0u64;
    let mut truncated = list.truncated;
    for relative in body.split('\0') {
        let relative = relative.trim_start_matches("./");
        if relative.is_empty() {
            continue;
        }
        if !keep_path(relative, &excludes) {
            skipped += 1;
            continue;
        }
        if files.len() >= MAX_SNAPSHOT_FILES {
            truncated = true;
            skipped += 1;
            continue;
        }
        files.push(relative.to_string());
    }
    if files.is_empty() {
        warnings.push("the code snapshot is empty; check the project exclusions".into());
    }
    let list_path = format!("{run_dir}/snapshot.list");
    let sftp = sftp_for(transport.clone()).await?;
    let mut listed = Vec::new();
    for file in &files {
        listed.extend_from_slice(file.as_bytes());
        listed.push(0);
    }
    sftp.write(&list_path, &listed, Some(0o644)).await?;
    drop(sftp);
    let code_dir = format!("{run_dir}/code");
    let archive = format!("{run_dir}/code.tar");
    // Two steps rather than a pipe: `tar | tar` reports only the extractor's
    // status, so a listing that could not be read would look like a success.
    // The archive is removed after extraction; it is only a staging file.
    let script = format!(
        r#"cd {root} || exit 2
tar --null -T {list} -cf {archive} || exit 3
tar -C {code} -xf {archive} || exit 4
rm -f {archive}
find {code} \( -type f -o -type l \) 2>/dev/null | wc -l
du -sb {code} 2>/dev/null | cut -f1
"#,
        root = shell_quote(root),
        list = shell_quote(&list_path),
        archive = shell_quote(&archive),
        code = shell_quote(&code_dir),
    );
    let result = exec_checked(transport, &script, 4096, Duration::from_secs(120)).await?;
    let mut numbers = result
        .stdout
        .lines()
        .rev()
        .filter_map(|line| line.trim().parse::<u64>().ok());
    let bytes = numbers.next().unwrap_or(0);
    let extracted = numbers.next().unwrap_or(0);
    let complete = result.exit_code.unwrap_or(1) == 0;
    let verified = complete && extracted == files.len() as u64 && !truncated;
    if !complete {
        warnings.push(format!(
            "the code snapshot could not be completed: {}",
            first_line(&result.stderr)
        ));
    } else if !verified {
        warnings.push(format!(
            "the code snapshot holds {extracted} of {} files; it is not a complete copy",
            files.len()
        ));
    }
    Ok(RunSnapshot {
        mode: SnapshotMode::Code,
        path: code_dir,
        files: files.len() as u64,
        bytes,
        skipped: if truncated { skipped.max(1) } else { skipped },
        verified,
        note: if !complete {
            "the copy did not finish; it cannot back an isolated run".into()
        } else if !verified {
            format!(
                "the copy has {extracted} of {} files; it is not a complete copy",
                files.len()
            )
        } else if truncated {
            format!(
                "the snapshot hit the {MAX_SNAPSHOT_FILES}-file limit; it is not a complete copy"
            )
        } else if skipped > 0 {
            "data, weight and output directories were left out of the snapshot".into()
        } else {
            "a complete copy of the code files at launch time".into()
        },
    })
}

pub async fn run_status(
    state: &crate::commands::AppState,
    id: &str,
    run: &RunRecord,
) -> Result<RunObservation> {
    let (_, transport) = transport_of(state, id)?;
    let dir = validate_path(&run.run_dir)?;
    let quoted = shell_quote(dir);
    let name = shell_quote(&run.task_name);
    let script = format!(
        r#"d={quoted}
if [ -f "$d/exit_code" ]; then printf '__ET__:exit\n'; head -c 32 "$d/exit_code"; printf '\n'; fi
if [ -f "$d/ended_at" ]; then printf '__ET__:ended\n'; head -c 32 "$d/ended_at"; printf '\n'; fi
if [ -f "$d/run.log" ]; then printf '__ET__:log\n'; wc -c < "$d/run.log"; else printf '__ET__:log\n0\n'; fi
if [ -f "$d/env_ok" ]; then printf '__ET__:env\n1\n'; else printf '__ET__:env\n0\n'; fi
if [ "{}" = "tmux" ]; then
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t {name} 2>/dev/null; then printf '__ET__:alive\n1\n'; fi
else
  if [ -f "$d/pid" ]; then p=$(head -c 32 "$d/pid"); if kill -0 "$p" 2>/dev/null; then printf '__ET__:alive\n1\n'; fi; fi
fi
"#,
        match run.mode {
            RunMode::Tmux => "tmux",
            _ => "detached",
        }
    );
    let output = exec_checked(transport, &script, 64 * 1024, Duration::from_secs(10)).await?;
    let sections = parse_sections(&output.stdout);
    let exit_code = sections
        .get("exit")
        .and_then(|value| first_line(value).parse::<u32>().ok());
    let ended_at = sections
        .get("ended")
        .and_then(|value| first_line(value).parse::<i64>().ok());
    let log_size = sections
        .get("log")
        .and_then(|value| first_line(value).parse::<u64>().ok())
        .unwrap_or(0);
    let alive = first_line(sections.get("alive").copied().unwrap_or("")) == "1";
    // A record written before the environment marker existed has no binding;
    // it keeps the old interpretation instead of reporting every non-zero
    // exit as an environment failure.
    let env_ready = first_line(sections.get("env").copied().unwrap_or("")) == "1"
        || run.binding.executed_from.is_empty();
    let (status, note) = interpret_run(exit_code, alive, run.submit_only, run.status, env_ready);
    Ok(RunObservation {
        status,
        exit_code,
        alive,
        log_size,
        checked_at: now_ms(),
        note: if note.is_empty() {
            ended_at
                .map(|at| format!("last wrote its end at {at}"))
                .unwrap_or_default()
        } else {
            note
        },
    })
}

pub async fn stop_run(state: &crate::commands::AppState, id: &str, run: &RunRecord) -> Result<()> {
    let (_, transport) = transport_of(state, id)?;
    let dir = validate_path(&run.run_dir)?;
    let name = shell_quote(&run.task_name);
    let script = match run.mode {
        RunMode::Tmux => format!(
            "tmux kill-session -t {name} 2>/dev/null || true; d={} ; printf 'stopped\\n' > \"$d/state\"",
            shell_quote(dir)
        ),
        _ => format!(
            "d={}; if [ -f \"$d/pid\" ]; then p=$(head -c 32 \"$d/pid\"); kill \"$p\" 2>/dev/null || true; fi; printf 'stopped\\n' > \"$d/state\"",
            shell_quote(dir)
        ),
    };
    let output = exec_checked(transport, &script, 4096, Duration::from_secs(10)).await?;
    if output.exit_code.unwrap_or(0) != 0 {
        return Err(AppError::new(format!(
            "the run could not be stopped: {}",
            first_line(&output.stderr)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_single_quotes_newlines_and_spaces() {
        assert_eq!(shell_quote("/data/my project"), "'/data/my project'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
    }

    fn profile(host: &str, port: u16, username: &str) -> SessionProfile {
        SessionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "lab".into(),
            kind: crate::model::SessionKind::Ssh,
            color: None,
            group_id: None,
            encoding: None,
            locale: None,
            backspace: None,
            record: false,
            record_dir: None,
            shell: None,
            cwd: None,
            host: Some(host.into()),
            port: Some(port),
            username: Some(username.into()),
            auth: None,
            password: None,
            private_key_path: None,
            passphrase: None,
            jump_profile_id: None,
            forwards: Vec::new(),
            port_name: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
        }
    }

    #[test]
    fn the_write_lock_follows_the_file_not_the_session() {
        // Two sessions on one host, one file: one key, so their saves cannot
        // interleave.
        let first = profile("gpu-01", 22, "lab");
        let mut second = profile("gpu-01", 22, "lab");
        second.id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&second, "/data/vfi/src/train.py")
        );

        // The same path on another endpoint, or another file, is a different
        // file.
        assert_ne!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&profile("gpu-01", 2222, "lab"), "/data/vfi/src/train.py")
        );
        assert_ne!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&first, "/data/vfi/src/model.py")
        );
    }

    #[test]
    fn path_spellings_share_one_lock_key() {
        assert_eq!(normalize_remote_path("/data//vfi/./src/"), "/data/vfi/src");
        assert_eq!(
            normalize_remote_path("/data/vfi/../vfi/src"),
            "/data/vfi/src"
        );
        assert_eq!(normalize_remote_path("/"), "/");
    }

    #[test]
    fn two_saves_of_one_file_cannot_both_hold_the_lock() {
        let ops = ProjectOps::default();
        let key = write_lock_key(&profile("gpu-01", 22, "lab"), "/data/vfi/a.py");
        let first = ops.begin_write(key.clone()).unwrap();
        let conflict = ops
            .begin_write(key.clone())
            .err()
            .expect("second write is refused");
        assert_eq!(conflict.code, ErrorCode::Conflict);
        drop(first);
        assert!(ops.begin_write(key).is_ok(), "the lock is released on drop");
    }

    #[test]
    fn eol_detection_and_normalisation_round_trip() {
        assert_eq!(eol_of("a\nb\n"), "lf");
        assert_eq!(eol_of("a\r\nb\r\n"), "crlf");
        assert_eq!(eol_of("a\rb\r"), "cr");
        assert_eq!(apply_eol("a\r\nb", "lf"), "a\nb");
        assert_eq!(apply_eol("a\nb", "crlf"), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb", "crlf"), "a\r\nb");
    }

    #[test]
    fn quick_open_keeps_code_and_config_but_not_data_or_weights() {
        let none = HashSet::new();
        assert!(keep_path("src/model.py", &none));
        assert!(
            keep_path("src/data/loader.py", &none),
            "a code package named data is not a dataset directory"
        );
        assert!(!keep_path("data/frames/0001.png", &none));
        assert!(!keep_path("datasets/sample.mp4", &none));
        assert!(keep_path("configs/base.yaml", &none));
        assert!(keep_path("scripts/train.sh", &none));
        assert!(keep_path("Dockerfile", &none));
        assert!(keep_path("requirements.txt", &none));
        assert!(!keep_path("data/clip.mp4", &none));
        assert!(!keep_path("checkpoints/model.pth", &none));
        assert!(!keep_path("__pycache__/model.cpython-311.pyc", &none));
        assert!(!keep_path("assets/frame.png", &none));
        let mut excludes = HashSet::new();
        excludes.insert("vendor".into());
        assert!(!keep_path("vendor/lib.py", &excludes));
    }

    #[test]
    fn git_status_parsing_drops_the_rename_source_and_keeps_untracked() {
        let raw = " M src/train.py\0?? notes.md\0R  src/new.py\0src/old.py\0";
        let files = parse_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/train.py");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[1].status, "??");
        assert_eq!(files[2].path, "src/new.py");
        assert_eq!(files[2].status, "R");
    }

    #[test]
    fn search_records_accept_both_grep_and_git_grep_shapes() {
        assert_eq!(
            parse_search_record("src/a.py\0 12:value"),
            Some(("src/a.py", 12, "value"))
        );
        assert_eq!(
            parse_search_record("src/b.py\0 7\0value: with colon"),
            Some(("src/b.py", 7, "value: with colon"))
        );
        assert_eq!(parse_search_record("no separator"), None);
        assert_eq!(parse_search_record("src/a.py\0not-a-line:text"), None);
    }

    #[test]
    fn sentinel_sections_keep_multiline_diff_content() {
        let output =
            "__ET__:branch\nmain\n__ET__:status\n M a.py\0__ET__:diff\ndiff --git a\n+line\n";
        let sections = parse_sections(output);
        assert_eq!(sections.get("branch"), Some(&"main"));
        assert_eq!(sections.get("status"), Some(&" M a.py\0"));
        assert_eq!(sections.get("diff"), Some(&"diff --git a\n+line"));
    }

    #[test]
    fn scheduler_detection_requires_the_command_to_match_an_installed_one() {
        assert_eq!(
            scheduler_for("sbatch train.slurm", Some("slurm")),
            Some(("slurm".into(), true))
        );
        assert_eq!(
            scheduler_for("/usr/bin/qsub job.sh", Some("pbs")),
            Some(("pbs".into(), true))
        );
        assert_eq!(
            scheduler_for("srun python train.py", Some("slurm")),
            Some(("slurm".into(), false)),
            "srun is a foreground run, not a submission"
        );
        assert_eq!(scheduler_for("python train.py", Some("slurm")), None);
        assert_eq!(scheduler_for("sbatch train.slurm", None), None);
        assert_eq!(scheduler_for("sbatch train.slurm", Some("pbs")), None);
    }

    #[test]
    fn run_directories_are_keyed_by_run_id_and_stay_inside_the_project() {
        assert_eq!(
            default_run_dir("/data/vfi/", "", "run-1"),
            "/data/vfi/.edgeterm/runs/run-1"
        );
        assert_eq!(
            default_run_dir("/data/vfi", "/mnt/fast/runs/", "run-1"),
            "/mnt/fast/runs/run-1"
        );
        let excludes = snapshot_excludes(
            "/data/vfi",
            "/data/vfi/.edgeterm/runs/run-1",
            &["datasets".into(), "vendor/lib".into()],
        );
        assert!(excludes.contains(".edgeterm"));
        assert!(excludes.contains("vendor"));
        assert!(excludes.contains(".git"));
        let custom = snapshot_excludes("/data/vfi", "/data/vfi/my_runs/run-1", &[]);
        assert!(
            custom.contains("my_runs"),
            "a custom run tree is not copied into itself"
        );
    }

    #[test]
    fn run_script_binds_the_directory_it_executes_in() {
        let script = build_command_script(
            "/data/vfi baseline",
            "/data/vfi baseline",
            "/data/runs/run-1",
            "conda activate vfi",
            "0,1",
            "python train.py --seed 1",
        );
        assert!(script.contains("cd '/data/vfi baseline' || exit 97"));
        assert!(script.contains("EDGETERM_PROJECT_ROOT='/data/vfi baseline'"));
        assert!(script.contains("EDGETERM_RUN_DIR='/data/runs/run-1'"));
        assert!(script.contains("conda.sh"));
        assert!(script.contains("conda activate vfi"));
        assert!(script.contains("CUDA_VISIBLE_DEVICES='0,1'"));
        assert!(script.contains("python train.py --seed 1"));
        // Environment preparation must stop the script: a failed activate
        // cannot fall through into training.
        let prepared = script
            .find("set -e")
            .expect("environment runs under set -e");
        let released = script
            .find("set +e")
            .expect("the command keeps its exit code");
        let marker = script.find("env_ok").expect("the ready marker is written");
        assert!(prepared < released && released < marker);
        assert!(marker < script.find("python train.py").unwrap());

        // Isolated: the command runs in the copy, while the project root is
        // still exported for absolute references.
        let isolated = build_command_script(
            "/data/runs/run-2/code",
            "/data/vfi",
            "/data/runs/run-2",
            "",
            "",
            "python train.py",
        );
        assert!(isolated.contains("cd '/data/runs/run-2/code' || exit 97"));
        assert!(isolated.contains("EDGETERM_PROJECT_ROOT='/data/vfi'"));
        assert!(
            !isolated.contains("conda.sh"),
            "no conda guess without conda activate"
        );
        assert!(!isolated.contains("CUDA_VISIBLE_DEVICES"));
    }

    #[test]
    fn isolated_links_stay_inside_the_project() {
        assert_eq!(validate_link(" datasets/kitti ").unwrap(), "datasets/kitti");
        assert!(validate_link("/etc").is_err());
        assert!(validate_link("data/../../etc").is_err());
        assert!(validate_link("data//x").is_err());
        assert!(validate_link("   ").is_err());
    }

    #[test]
    fn listing_headers_are_removed_but_the_nul_list_is_kept() {
        let (source, body) = split_listing("__ET__:source\ngit\nsrc/a.py\0src/b.py\0");
        assert_eq!(source, "git");
        assert_eq!(body, "src/a.py\0src/b.py\0");
        let (source, body) = split_listing("__ET__:source\nfind\n");
        assert_eq!(source, "find");
        assert_eq!(body, "");
    }

    #[test]
    fn run_status_separates_submission_clean_exit_loss_and_stop() {
        assert_eq!(
            interpret_run(Some(0), false, true, RunStatus::Running, true).0,
            RunStatus::Submitted,
            "a clean sbatch exit is a submission, not a finished training job"
        );
        assert_eq!(
            interpret_run(Some(0), false, false, RunStatus::Running, true).0,
            RunStatus::Finished
        );
        assert_eq!(
            interpret_run(Some(3), false, false, RunStatus::Running, true).0,
            RunStatus::Failed
        );
        assert_eq!(
            interpret_run(None, true, false, RunStatus::Running, false).0,
            RunStatus::Running
        );
        assert_eq!(
            interpret_run(None, false, false, RunStatus::Running, true).0,
            RunStatus::Lost
        );
        assert_eq!(
            interpret_run(None, false, false, RunStatus::Stopped, false).0,
            RunStatus::Stopped
        );
        assert_eq!(
            interpret_run(None, false, true, RunStatus::Submitted, true).0,
            RunStatus::Unknown
        );
    }

    #[test]
    fn an_environment_failure_is_not_reported_as_a_training_failure() {
        let (status, note) = interpret_run(Some(1), false, false, RunStatus::Running, false);
        assert_eq!(status, RunStatus::Failed);
        assert!(
            note.contains("environment setup failed") && note.contains("not run"),
            "the note must say the command never ran: {note}"
        );

        // The same exit code with the marker written is a training failure.
        let (status, note) = interpret_run(Some(1), false, false, RunStatus::Running, true);
        assert_eq!(status, RunStatus::Failed);
        assert_eq!(note, "exit code 1");

        // A missing directory is its own case, not an environment failure.
        let (status, note) = interpret_run(Some(97), false, false, RunStatus::Running, false);
        assert_eq!(status, RunStatus::Failed);
        assert!(note.contains("run directory"));
    }

    #[test]
    fn task_names_are_bounded_and_shell_safe() {
        assert_eq!(task_name("3f2a-11bc"), "et-3f2a11bc");
        assert!(task_name(&"x".repeat(100)).len() <= 27);
        assert!(task_name("../../etc")
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn invalid_paths_are_refused_before_they_reach_a_shell() {
        assert!(validate_path("").is_err());
        assert!(validate_path("a\nb").is_err());
        assert!(validate_path("a\0b").is_err());
        assert_eq!(validate_path(" /data/a.py ").unwrap(), "/data/a.py");
    }

    #[test]
    fn concurrent_saves_of_one_path_are_refused() {
        let ops = ProjectOps::default();
        let guard = ops.begin_write("session:/a.py".into()).unwrap();
        let second = ops.begin_write("session:/a.py".into());
        assert!(second.is_err());
        guard.finish();
        assert!(ops.begin_write("session:/a.py".into()).is_ok());
    }
}
