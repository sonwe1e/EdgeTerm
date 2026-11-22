//! Git worktree operations against the system Git or an existing SSH login.
mod runner;
mod status;

pub use status::{GitChangeKind, GitScope, GitSelection, GitStatus};

use std::{ops::Range, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use self::runner::Runner;
use crate::{
    commands::AppState,
    error::{err, AppError, ErrorCode, Result},
    project::sha256_hex,
    session::exec::CommandOutput,
};

const STATUS_LIMIT: usize = 4 * 1024 * 1024;
const PATCH_LIMIT: usize = 384 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(12);
const WRITE_TIMEOUT: Duration = Duration::from_secs(25);
const DIFF_ARGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--submodule=short",
    "--unified=3",
    "--inter-hunk-context=0",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitTarget {
    pub session_id: Option<String>,
    pub directory: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub enum GitDiffTarget {
    File { file: GitSelection },
    Commit { oid: String },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub enum GitPatchKind {
    Text,
    Empty,
    Binary,
    TooLarge,
    Encoding,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitPatch {
    pub kind: GitPatchKind,
    pub text: String,
    /// Only patches that can be applied to the index have a token.
    pub token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitCommit {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub enum GitAction {
    Stage {
        path: Option<String>,
    },
    Unstage {
        path: Option<String>,
    },
    Hunk {
        path: String,
        scope: GitScope,
        index: usize,
        token: String,
    },
    Commit {
        message: String,
        token: String,
    },
    Switch {
        branch: String,
        token: String,
    },
    CreateBranch {
        branch: String,
        token: String,
    },
}

pub struct GitWorktree {
    directory: String,
    runner: Runner,
}

impl GitWorktree {
    pub fn new(state: &AppState, target: GitTarget) -> Result<Self> {
        let runner = if let Some(id) = target.session_id {
            let transport = state
                .ssh_transports
                .get(&id)
                .ok_or_else(|| AppError::connection_failed("SSH connection is unavailable"))?;
            Runner::Ssh(transport)
        } else {
            Runner::Local
        };
        Ok(Self {
            directory: target.directory,
            runner,
        })
    }

    async fn read(&self, directory: &str, args: &[&str], limit: usize) -> Result<CommandOutput> {
        self.runner
            .run(directory, args, None, limit, READ_TIMEOUT)
            .await
    }

    async fn root(&self) -> Result<Option<String>> {
        let output = self
            .read(&self.directory, &["rev-parse", "--show-toplevel"], 32768)
            .await?;
        if output.exit != Some(0) {
            let message = String::from_utf8_lossy(&output.stderr);
            if message.contains("not a git repository")
                || message.contains("must be run in a work tree")
            {
                return Ok(None);
            }
        }
        let bytes = successful(output)?;
        let root = std::str::from_utf8(&bytes).map_err(err)?;
        let root = root
            .strip_suffix('\n')
            .ok_or_else(|| err("Git did not report a worktree root"))?;
        let root = if self.runner.windows() {
            root.strip_suffix('\r').unwrap_or(root)
        } else {
            root
        };
        Ok(Some(root.to_owned()))
    }

    pub async fn status(&self) -> Result<Option<GitStatus>> {
        let Some(root) = self.root().await? else {
            return Ok(None);
        };
        let output = self
            .read(
                &root,
                &[
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--branch",
                    "--ahead-behind",
                    "--renames",
                    "--untracked-files=all",
                    "--ignore-submodules=none",
                ],
                STATUS_LIMIT,
            )
            .await?;
        Ok(Some(status::parse(root, &successful(output)?)?))
    }

    fn validate_path(&self, path: &str) -> Result<()> {
        let invalid =
            path.contains('\0') || path.split('/').any(|part| matches!(part, "" | "." | ".."));
        if invalid || (self.runner.windows() && path.contains(['\\', ':'])) {
            return Err(AppError::invalid_input(
                "Git requires a repository-relative file path",
            ));
        }
        Ok(())
    }

    async fn file_patch(&self, file: &GitSelection) -> Result<GitPatch> {
        self.validate_path(&file.path)?;
        if let Some(path) = &file.original_path {
            self.validate_path(path)?;
        }
        let untracked = file.scope == GitScope::Working && file.kind == GitChangeKind::Untracked;
        let mut args = vec!["diff"];
        args.extend(DIFF_ARGS);
        let relative = format!("./{}", file.path);
        if untracked {
            args.extend(["--no-index", "--", "/dev/null", &relative]);
        } else {
            match file.scope {
                GitScope::Staged => args.push("--cached"),
                GitScope::Conflict => args.push("--cc"),
                GitScope::Working => {}
            }
            args.extend(["--", &file.path]);
            args.extend(file.original_path.as_deref());
        }
        let output = self.read(&self.directory, &args, PATCH_LIMIT).await?;
        let partial = file.scope != GitScope::Conflict && file.kind == GitChangeKind::Modified;
        patch(output, untracked, partial)
    }

    pub async fn diff(&self, target: GitDiffTarget) -> Result<GitPatch> {
        match target {
            GitDiffTarget::File { file } => self.file_patch(&file).await,
            GitDiffTarget::Commit { oid } => {
                validate_oid(&oid)?;
                let mut args = vec![
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--first-parent",
                    "-m",
                    "-p",
                ];
                args.extend(DIFF_ARGS);
                args.extend([&oid, "--"]);
                patch(
                    self.read(&self.directory, &args, PATCH_LIMIT).await?,
                    false,
                    false,
                )
            }
        }
    }

    pub async fn history(&self, head: &str) -> Result<Vec<GitCommit>> {
        validate_oid(head)?;
        let bytes = successful(
            self.read(
                &self.directory,
                &[
                    "log",
                    "-60",
                    "-z",
                    "--no-show-signature",
                    "--encoding=UTF-8",
                    "--format=%H%x00%h%x00%s%x00%an%x00%aI",
                    head,
                    "--",
                ],
                512 * 1024,
            )
            .await?,
        )?;
        let text = String::from_utf8_lossy(&bytes);
        let fields: Vec<_> = text.split_terminator('\0').collect();
        fields
            .chunks(5)
            .map(|record| {
                let [oid, short_oid, subject, author, date] = record else {
                    return Err(err("Git returned an incomplete commit record"));
                };
                Ok(GitCommit {
                    oid: (*oid).into(),
                    short_oid: (*short_oid).into(),
                    subject: (*subject).into(),
                    author: (*author).into(),
                    date: (*date).into(),
                })
            })
            .collect()
    }

    pub async fn branches(&self) -> Result<Vec<String>> {
        let bytes = successful(
            self.read(
                &self.directory,
                &[
                    "for-each-ref",
                    "--sort=-committerdate",
                    "--format=%(refname:lstrip=2)",
                    "refs/heads/",
                ],
                512 * 1024,
            )
            .await?,
        )?;
        Ok(std::str::from_utf8(&bytes)
            .map_err(err)?
            .lines()
            .map(str::to_owned)
            .collect())
    }

    async fn write(&self, args: &[&str], input: Option<&[u8]>) -> Result<()> {
        let output = self
            .runner
            .run(&self.directory, args, input, 8192, WRITE_TIMEOUT)
            .await?;
        // A verbose hook must not turn a successful commit into a failed one.
        check_exit(&output, false)
    }

    async fn stage(&self, status: &GitStatus, path: Option<String>, staged: bool) -> Result<()> {
        let mut args = if staged {
            vec!["reset", "-q", "--"]
        } else {
            vec!["add", "-A", "--"]
        };
        if let Some(path) = path.as_deref() {
            self.validate_path(path)?;
            let change = find_change(status, path)?;
            let scope = if staged {
                GitScope::Staged
            } else if change.conflicted {
                GitScope::Conflict
            } else {
                GitScope::Working
            };
            let file = change.selection(scope).ok_or_else(stale)?;
            args.push(path);
            // A renamed index entry is two paths. A copy only affects its destination.
            if let Some(original) = file
                .original_path
                .as_deref()
                .filter(|_| file.kind == GitChangeKind::Renamed)
            {
                self.validate_path(original)?;
                args.push(original);
            }
            return self.write(&args, None).await;
        }
        if status.changes.iter().any(|change| change.conflicted) {
            return Err(err(
                "Resolve conflicting files individually before changing the entire index",
            ));
        }
        args.push(".");
        self.write(&args, None).await
    }

    async fn hunk(
        &self,
        status: &GitStatus,
        path: &str,
        scope: GitScope,
        index: usize,
        token: &str,
    ) -> Result<()> {
        let file = find_change(status, path)?
            .selection(scope)
            .ok_or_else(stale)?;
        let patch = self.file_patch(&file).await?;
        if patch.token.as_deref() != Some(token) {
            return Err(stale());
        }
        let ranges = hunk_ranges(&patch.text);
        let range = ranges.get(index).ok_or_else(stale)?;
        let input = [&patch.text[..ranges[0].start], &patch.text[range.clone()]].concat();
        let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
        if scope == GitScope::Staged {
            args.push("--reverse");
        }
        args.push("-");
        self.write(&args, Some(input.as_bytes())).await
    }

    pub async fn mutate(&self, action: GitAction) -> Result<()> {
        // The desktop owns one write at a time. Git still locks its own index
        // against other clients and the immediately preceding read detects
        // stale review data supplied by the UI.
        static WRITES: Mutex<()> = Mutex::const_new(());
        let _write = WRITES.lock().await;
        let status = self.status().await?.ok_or_else(stale)?;
        if status.root != self.directory {
            return Err(stale());
        }
        match action {
            GitAction::Stage { path } => self.stage(&status, path, false).await,
            GitAction::Unstage { path } => self.stage(&status, path, true).await,
            GitAction::Hunk {
                path,
                scope,
                index,
                token,
            } => self.hunk(&status, &path, scope, index, &token).await,
            GitAction::Commit { message, token } => {
                check_token(&status, &token)?;
                if status.changes.iter().any(|change| change.conflicted) {
                    return Err(err("Resolve all conflicts before committing"));
                }
                if !status.changes.iter().any(|change| change.staged.is_some()) {
                    return Err(err("There are no staged changes to commit"));
                }
                if message.trim().is_empty() || message.len() > 16 * 1024 || message.contains('\0')
                {
                    return Err(AppError::invalid_input(
                        "A commit needs a message of up to 16 KiB",
                    ));
                }
                let input = format!("{}\n", message.trim_end());
                self.write(
                    &["commit", "--quiet", "--cleanup=whitespace", "-F", "-"],
                    Some(input.as_bytes()),
                )
                .await
            }
            GitAction::Switch { branch, token } => {
                check_token(&status, &token)?;
                if !self.branches().await?.contains(&branch) {
                    return Err(stale());
                }
                self.write(&["switch", "--no-guess", "--", &branch], None)
                    .await
            }
            GitAction::CreateBranch { branch, token } => {
                check_token(&status, &token)?;
                if branch.starts_with('-') || branch.contains('\0') || branch.trim().is_empty() {
                    return Err(AppError::invalid_input("Enter a Git branch name"));
                }
                self.write(&["switch", "-c", &branch], None).await
            }
        }
    }
}

fn stale() -> AppError {
    AppError::coded(
        ErrorCode::Conflict,
        "The Git worktree or index changed since it was reviewed",
    )
}

fn check_token(status: &GitStatus, token: &str) -> Result<()> {
    if status.commit_token != token {
        return Err(stale());
    }
    Ok(())
}

fn find_change<'a>(status: &'a GitStatus, path: &str) -> Result<&'a status::GitChange> {
    status
        .changes
        .iter()
        .find(|change| change.path == path)
        .ok_or_else(stale)
}

fn validate_oid(oid: &str) -> Result<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::invalid_input("Git requires a full commit ID"));
    }
    Ok(())
}

fn check_exit(output: &CommandOutput, untracked_diff: bool) -> Result<()> {
    if output.exit == Some(0)
        || (untracked_diff && output.exit == Some(1) && output.stderr.is_empty())
    {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr);
    let message = message.trim();
    Err(err(if message.is_empty() {
        "Git command failed"
    } else {
        message
    }))
}

fn successful(output: CommandOutput) -> Result<Vec<u8>> {
    check_exit(&output, false)?;
    if output.truncated {
        return Err(err("Git output exceeded the workbench limit"));
    }
    Ok(output.stdout)
}

fn patch(output: CommandOutput, untracked: bool, partial: bool) -> Result<GitPatch> {
    check_exit(&output, untracked)?;
    let unavailable = |kind| GitPatch {
        kind,
        text: String::new(),
        token: None,
    };
    if output.truncated || output.stdout.iter().filter(|byte| **byte == b'\n').count() > 5000 {
        return Ok(unavailable(GitPatchKind::TooLarge));
    }
    let Ok(text) = String::from_utf8(output.stdout) else {
        return Ok(unavailable(GitPatchKind::Encoding));
    };
    if text.is_empty() {
        return Ok(unavailable(GitPatchKind::Empty));
    }
    let first_hunk = text.find("\n@@ ").map(|index| index + 1);
    if first_hunk.is_none() && text.lines().any(|line| line.starts_with("Binary files ")) {
        return Ok(unavailable(GitPatchKind::Binary));
    }
    let header = first_hunk.map(|end| &text[..end]);
    let can_apply = partial
        && text.ends_with('\n')
        && !text.contains("\ndiff --git ")
        && header.is_some_and(|header| {
            header.lines().any(|line| {
                line.starts_with("index ")
                    && (line.ends_with(" 100644") || line.ends_with(" 100755"))
            }) && !header.contains("\nold mode ")
        });
    let token = can_apply.then(|| sha256_hex(text.as_bytes()));
    Ok(GitPatch {
        kind: GitPatchKind::Text,
        text,
        token,
    })
}

fn hunk_ranges(text: &str) -> Vec<Range<usize>> {
    let mut starts = text
        .match_indices("\n@@ ")
        .map(|(index, _)| index + 1)
        .peekable();
    let mut ranges = Vec::new();
    while let Some(start) = starts.next() {
        ranges.push(start..starts.peek().copied().unwrap_or(text.len()));
    }
    ranges
}

#[cfg(test)]
mod tests;
