use serde::{Deserialize, Serialize};

use crate::{
    error::{err, Result},
    project::sha256_hex,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub enum GitScope {
    Working,
    Staged,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitSelection {
    pub path: String,
    pub original_path: Option<String>,
    pub scope: GitScope,
    pub kind: GitChangeKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitChange {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: Option<GitChangeKind>,
    pub working: Option<GitChangeKind>,
    pub conflicted: bool,
}

impl GitChange {
    pub(super) fn selection(&self, scope: GitScope) -> Option<GitSelection> {
        let kind = match scope {
            GitScope::Staged => self.staged,
            GitScope::Working => self.working,
            GitScope::Conflict => self.conflicted.then_some(GitChangeKind::Conflict),
        }?;
        let original_path = self
            .original_path
            .clone()
            .filter(|_| matches!(kind, GitChangeKind::Renamed | GitChangeKind::Copied));
        Some(GitSelection {
            path: self.path.clone(),
            original_path,
            scope,
            kind,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct GitStatus {
    pub root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
    pub commit_token: String,
}

fn kind(status: u8) -> Result<Option<GitChangeKind>> {
    use GitChangeKind::*;
    Ok(Some(match status {
        b'.' => return Ok(None),
        b'A' => Added,
        b'M' => Modified,
        b'D' => Deleted,
        b'R' => Renamed,
        b'C' => Copied,
        b'T' => TypeChanged,
        _ => return Err(err("Git returned an unknown change status")),
    }))
}

pub(super) fn parse(root: String, bytes: &[u8]) -> Result<GitStatus> {
    let text = std::str::from_utf8(bytes).map_err(|_| err("Git paths must be UTF-8"))?;
    let mut status = GitStatus {
        root,
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
        commit_token: String::new(),
    };
    let mut staged_snapshot = Vec::new();
    let mut counts_known = false;
    let mut records = text.split_terminator('\0');
    let invalid = || err("Git returned an incomplete status record");
    while let Some(record) = records.next() {
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            status.head = (oid != "(initial)").then(|| oid.to_owned());
        } else if let Some(name) = record.strip_prefix("# branch.head ") {
            status.branch = (name != "(detached)").then(|| name.to_owned());
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.into());
        } else if let Some(counts) = record.strip_prefix("# branch.ab +") {
            let (ahead, behind) = counts.split_once(" -").ok_or_else(invalid)?;
            status.ahead = ahead.parse().map_err(err)?;
            status.behind = behind.parse().map_err(err)?;
            counts_known = true;
        } else if let Some(path) = record.strip_prefix("? ") {
            status.changes.push(GitChange {
                path: path.into(),
                original_path: None,
                staged: None,
                working: Some(GitChangeKind::Untracked),
                conflicted: false,
            });
        } else if record.starts_with("u ") {
            let path = record.splitn(11, ' ').nth(10).ok_or_else(invalid)?;
            status.changes.push(GitChange {
                path: path.into(),
                original_path: None,
                staged: None,
                working: None,
                conflicted: true,
            });
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            let renamed = record.starts_with("2 ");
            let fields: Vec<_> = record.splitn(if renamed { 10 } else { 9 }, ' ').collect();
            let path = fields
                .get(if renamed { 9 } else { 8 })
                .ok_or_else(invalid)?;
            let [x, y] = fields[1].as_bytes() else {
                return Err(invalid());
            };
            let original_path = if renamed {
                Some(records.next().ok_or_else(invalid)?.to_owned())
            } else {
                None
            };
            let staged = kind(*x)?;
            if staged.is_some() {
                // HEAD and index modes and object names describe exactly what
                // the index contains. The working-tree side can keep changing.
                for part in [
                    &fields[1][..1],
                    fields[3],
                    fields[4],
                    fields[6],
                    fields[7],
                    path,
                ] {
                    staged_snapshot.extend_from_slice(part.as_bytes());
                    staged_snapshot.push(0);
                }
                if let Some(original) = original_path
                    .as_deref()
                    .filter(|_| matches!(x, b'R' | b'C'))
                {
                    staged_snapshot.extend_from_slice(original.as_bytes());
                }
                staged_snapshot.push(0);
            }
            status.changes.push(GitChange {
                path: (*path).into(),
                original_path,
                staged,
                working: kind(*y)?,
                conflicted: false,
            });
        } else if !record.starts_with("# ") {
            return Err(invalid());
        }
    }
    if !counts_known {
        status.upstream = None;
    }
    for field in [
        Some(status.root.as_str()),
        status.head.as_deref(),
        status.branch.as_deref(),
    ] {
        staged_snapshot.extend_from_slice(field.unwrap_or_default().as_bytes());
        staged_snapshot.push(0);
    }
    status.commit_token = sha256_hex(&staged_snapshot);
    Ok(status)
}
