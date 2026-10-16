use super::*;

/// The only ids a journal directory may carry: 1–100 characters of ASCII
/// alphanumerics and `-`. This excludes path separators, `..`, and every
/// form of absolute or nested path, before any of them reach `join`.
pub(super) fn valid_journal_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(super) fn require_journal_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        _ => Err(AppError::new("no such interrupted transfer directory")),
    }
}

/// Whether a checkpoint's item is one this journal's items cover. A folder
/// row covers exactly its planned children — same relative path on the
/// local and the remote side, with no `.`/`..` tricks — and a file row
/// covers only itself. The local side is compared through the same
/// `normalize` the engine applies (parent canonicalization), so a planned
/// child of `G:\dir` matches its `\\?\G:\dir\…` form.
pub(super) fn checkpoint_belongs(item: &Item, items: &[Item]) -> bool {
    items.iter().any(|row| {
        if row.upload != item.upload {
            return false;
        }
        if !row.directory {
            return row.remote.starts_with('/') == item.remote.starts_with('/')
                && posix_child(&item.remote, &row.remote).is_some_and(|parts| parts.is_empty())
                && same_local(&row.local, &item.local);
        }
        let (Some(local), Some(remote)) = (
            local_child(&item.local, &row.local),
            posix_child(&item.remote, &row.remote),
        ) else {
            return false;
        };
        // A checkpoint names a planned child, never the folder row itself,
        // and the plan keeps one relative path on both sides.
        !local.is_empty() && local == remote
    })
}

/// Whether two local paths name the same file for attribution purposes:
/// exactly equal, or equal after the engine's own parent-canonicalizing
/// `normalize` (which yields `\\?\`-prefixed forms on Windows).
pub(super) fn same_local(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (Ok(a), Ok(b)) = (local::normalize(a), local::normalize(b)) else {
        return false;
    };
    a == b
}

/// The components of a local path, refusing anything that could wander:
/// parent-directory components, current-directory components, and (by
/// construction of `Component`) any prefix-relative shape. Windows accepts
/// both separators here; `Path` normalizes them. `\\?\`-prefixed forms
/// parse into the same components.
pub(super) fn local_components(path: &str) -> Option<Vec<String>> {
    let mut components = Vec::new();
    for component in Path::new(path).components() {
        match component {
            std::path::Component::Normal(part) => {
                components.push(part.to_string_lossy().into_owned())
            }
            std::path::Component::RootDir => components.push("@root".into()),
            std::path::Component::Prefix(prefix) => {
                #[cfg(windows)]
                let identity = match prefix.kind() {
                    std::path::Prefix::Disk(disk) | std::path::Prefix::VerbatimDisk(disk) => {
                        format!("@disk:{}", disk.to_ascii_uppercase())
                    }
                    std::path::Prefix::UNC(server, share)
                    | std::path::Prefix::VerbatimUNC(server, share) => format!(
                        "@unc:{}/{}",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    ),
                    _ => format!("@prefix:{}", prefix.as_os_str().to_string_lossy()),
                };
                #[cfg(not(windows))]
                let identity = format!("@prefix:{}", prefix.as_os_str().to_string_lossy());
                components.push(identity);
            }
            std::path::Component::CurDir | std::path::Component::ParentDir => return None,
        }
    }
    Some(components)
}

/// The relative components of `child` under `parent`, both local paths;
/// `Some` only when `child` is `parent` itself or a real child of it.
pub(super) fn local_child(child: &str, parent: &str) -> Option<Vec<String>> {
    let child = local_components(child)?;
    let parent = local_components(parent)?;
    if child.len() < parent.len() || child[..parent.len()] != parent[..] {
        return None;
    }
    Some(child[parent.len()..].to_vec())
}

/// `local_child` for remote paths, which are always POSIX: split on `/`,
/// normalize repeated separators but refuse `.`/`..` and mismatched roots.
pub(super) fn posix_child(child: &str, parent: &str) -> Option<Vec<String>> {
    if child.starts_with('/') != parent.starts_with('/') {
        return None;
    }
    fn parts(path: &str) -> Option<Vec<String>> {
        path.split('/')
            .filter(|part| !part.is_empty())
            .map(|part| {
                if part == "." || part == ".." {
                    None
                } else {
                    Some(part.to_string())
                }
            })
            .collect()
    }
    let child = parts(child)?;
    let parent = parts(parent)?;
    if child.len() < parent.len() || child[..parent.len()] != parent[..] {
        return None;
    }
    Some(child[parent.len()..].to_vec())
}

/// Whether a checkpoint's saved partial/backup paths are exactly the ones
/// the engine derives from its own item and key. A saved path pointing
/// anywhere else — an arbitrary file swapped in for the partial — is not
/// claimed.
pub(super) fn checkpoint_paths_are_derived(cp: &Checkpoint) -> bool {
    if cp.item.upload {
        let parent = cp.item.remote.rsplit_once('/').map(|v| v.0).unwrap_or(".");
        cp.temporary == format!("{parent}/.edgeterm-{}.part", cp.key)
            && cp.backup == format!("{parent}/.edgeterm-{}.backup", cp.key)
    } else {
        let derived = local::sibling(Path::new(&cp.item.local), &cp.key, "part");
        cp.backup.is_empty()
            && derived
                .map(|path| cp.temporary == path.to_string_lossy())
                .unwrap_or(false)
    }
}

/// Where transfer journals live, beside the rest of the app's data.
pub(super) fn transfers_root() -> PathBuf {
    crate::store::portable_data_dir()
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("EdgeTerm")
        })
        .join("transfers")
}

/// The journal version this build writes and can recover; anything else is
/// refused rather than guessed at.
pub(super) const JOURNAL_VERSION: u64 = 2;

/// The exact JSON of a job journal, shared by `start` and the tests that
/// need a journal on disk without launching a worker.
pub(crate) fn journal_json(
    id: &str,
    profile: &SessionProfile,
    items: &[Item],
    options: &Options,
) -> serde_json::Value {
    serde_json::json!({
        "version": JOURNAL_VERSION,
        "id": id,
        "kind": journal_kind(profile),
        "endpoint": endpoint_key(profile),
        "host": profile.host,
        "port": profile.port,
        "username": profile.username,
        "jumpProfileId": profile.jump_profile_id,
        "items": items,
        "options": options
    })
}

/// `"sftp"` or `"ftp"`: the two protocols the engine journals distinguish.
pub(super) fn journal_kind(profile: &SessionProfile) -> &'static str {
    if profile.kind == SessionKind::Ftp {
        "ftp"
    } else {
        "sftp"
    }
}

pub(super) fn job_name(items: &[Item]) -> String {
    if items.len() == 1 {
        items[0]
            .remote
            .rsplit('/')
            .next()
            .unwrap_or("Transfer")
            .to_string()
    } else {
        format!("{} items", items.len())
    }
}

pub(super) fn recoverable_from(directory: &Path, id: &str) -> Option<Recoverable> {
    if require_journal_directory(directory).is_err() {
        return None;
    }
    let checkpoints = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name();
                    let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                        return false;
                    };
                    stem.len() == 24 && stem.bytes().all(|b| b.is_ascii_hexdigit())
                })
                .count()
        })
        .unwrap_or(0);
    let parsed = std::fs::read_to_string(directory.join("job.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let entry = |items: Vec<Item>,
                 kind: Option<String>,
                 endpoint: Option<String>,
                 host: Option<String>,
                 port: Option<u16>,
                 username: Option<String>| Recoverable {
        id: id.to_string(),
        name: job_name(&items),
        kind,
        endpoint,
        host,
        port,
        username,
        items: items.len(),
        checkpoints,
        unrecognized: false,
    };
    match parsed {
        Some(value) if value.get("version").and_then(|v| v.as_u64()) == Some(JOURNAL_VERSION) => {
            let items: Vec<Item> = serde_json::from_value(value.get("items").cloned()?).ok()?;
            let string = |field: &str| {
                value
                    .get(field)
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
            };
            Some(entry(
                items,
                string("kind"),
                string("endpoint"),
                string("host"),
                value
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .and_then(|p| u16::try_from(p).ok()),
                string("username"),
            ))
        }
        _ => Some(Recoverable {
            id: id.to_string(),
            name: "Unrecognized journal".into(),
            kind: None,
            endpoint: None,
            host: None,
            port: None,
            username: None,
            items: 0,
            checkpoints,
            unrecognized: true,
        }),
    }
}

pub(super) fn target_key(profile: &SessionProfile, item: &Item) -> String {
    if item.upload {
        format!("remote:{}:{}", endpoint_key(profile), item.remote)
    } else {
        #[cfg(windows)]
        let path = item.local.to_lowercase();
        #[cfg(not(windows))]
        let path = item.local.clone();
        format!("local:{path}")
    }
}

/// The checkpoint-file name (and journal key) of one item under one job:
/// derived from the job id and the exact paths and direction, so a journal
/// can tell its own checkpoints from anything planted beside them.
pub(super) fn checkpoint_key(job_id: &str, item: &Item) -> String {
    local::digest(
        format!(
            "{}\0{}\0{}\0{}",
            job_id, item.local, item.remote, item.upload
        )
        .as_bytes(),
    )[..24]
        .into()
}

pub(super) fn endpoint_key(profile: &SessionProfile) -> String {
    let ftp = profile.kind == SessionKind::Ftp;
    format!(
        "{}:{:?}:{:?}:{}:{:?}",
        if ftp { "ftp" } else { "sftp" },
        profile.host.as_deref().unwrap_or("").trim().to_lowercase(),
        profile
            .username
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(if ftp { "anonymous" } else { "" }),
        profile.port.unwrap_or(if ftp { 21 } else { 22 }),
        profile.jump_profile_id
    )
}

/// The endpoint identity a live session and a journal are matched on.
pub(crate) fn endpoint_of(profile: &SessionProfile) -> String {
    endpoint_key(profile)
}
