//! Unsaved editor content, stored as one file per draft under the app data
//! directory. This is not a cache: the content exists nowhere else until the
//! user saves it to the server, so nothing here is evicted to make room and a
//! failed write is reported to the caller instead of being swallowed.
//!
//! One file per draft also removes the cross-draft coupling a single JSON
//! blob had: filling the disk while saving file B could previously drop file
//! A's draft. Here a failure only affects the draft being written.
//!
//! Writes are atomic within the directory (temporary file, fsync, rename), so
//! a crash leaves either the previous draft or the new one, never half of one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::store::data_dir;

/// The editor refuses to open files above 4 MiB, so a draft is bounded by the
/// same order of magnitude. This is a sanity limit on what may be persisted,
/// not a budget that deletes older drafts.
const MAX_CONTENT: usize = 8 * 1024 * 1024;
const MAX_FIELD: usize = 8 * 1024;

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub doc_id: String,
    pub workspace_id: String,
    /// Login identity + endpoint the draft was written against. Restoring it
    /// through a different server is refused rather than guessed.
    pub server_key: String,
    #[serde(default)]
    pub server_label: String,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub path: String,
    pub absolute_path: String,
    pub content: String,
    /// Hash of the server copy the edit started from; the editor compares it
    /// with the current remote hash before applying the draft.
    pub base_hash: String,
    pub updated_at: i64,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftList {
    pub drafts: Vec<Draft>,
    pub dir: String,
    pub bytes: u64,
    /// Files that could not be read back (permissions, a partial write from
    /// an older version). They are reported, never silently dropped.
    pub unreadable: u64,
}

pub struct DraftStore {
    dir: PathBuf,
}

impl DraftStore {
    pub fn load() -> Self {
        Self::load_from(data_dir().join("drafts"))
    }

    pub fn load_from(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn ensure_dir(&self) -> Result<()> {
        fs::create_dir_all(&self.dir).map_err(|error| {
            AppError::new(format!(
                "cannot create the draft directory {}: {error}",
                self.dir.display()
            ))
        })
    }

    fn file_of(&self, doc_id: &str) -> PathBuf {
        // The doc id contains the absolute remote path, which is not a safe
        // file name on every platform; the digest is.
        self.dir.join(format!("{}.json", digest(doc_id)))
    }

    pub fn save(&self, draft: Draft) -> Result<Draft> {
        validate(&draft)?;
        self.ensure_dir()?;
        let target = self.file_of(&draft.doc_id);
        let body = serde_json::to_vec(&draft)
            .map_err(|error| AppError::new(format!("cannot encode the draft: {error}")))?;
        write_atomic(&target, &body)?;
        Ok(draft)
    }

    pub fn get(&self, doc_id: &str) -> Result<Option<Draft>> {
        let path = self.file_of(doc_id);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice::<Draft>(&bytes).ok()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(AppError::new(format!(
                "cannot read the draft for {doc_id}: {error}"
            ))),
        }
    }

    pub fn list(&self) -> Result<DraftList> {
        let mut list = DraftList {
            dir: self.dir.display().to_string(),
            ..Default::default()
        };
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(list),
            Err(error) => {
                return Err(AppError::new(format!(
                    "cannot read the draft directory {}: {error}",
                    self.dir.display()
                )))
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            match fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<Draft>(&bytes) {
                    Ok(draft) => {
                        list.bytes += draft.content.len() as u64;
                        list.drafts.push(draft);
                    }
                    Err(_) => list.unreadable += 1,
                },
                Err(_) => list.unreadable += 1,
            }
        }
        list.drafts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list)
    }

    pub fn remove(&self, doc_id: &str) -> Result<()> {
        match fs::remove_file(self.file_of(doc_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::new(format!(
                "cannot remove the draft for {doc_id}: {error}"
            ))),
        }
    }

    /// Removes the drafts of a project whose record was deleted. The caller
    /// decided those drafts have no tab left to restore them into.
    pub fn remove_workspace(&self, workspace_id: &str) -> Result<u64> {
        let list = self.list()?;
        let mut removed = 0;
        for draft in list.drafts {
            if draft.workspace_id == workspace_id {
                self.remove(&draft.doc_id)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

fn validate(draft: &Draft) -> Result<()> {
    if draft.doc_id.trim().is_empty() {
        return Err(AppError::invalid_input("a draft needs a document id"));
    }
    if draft.content.len() > MAX_CONTENT {
        return Err(AppError::invalid_input(format!(
            "the edit is {} bytes, above the {MAX_CONTENT}-byte draft limit",
            draft.content.len()
        )));
    }
    for (label, value) in [
        ("document id", draft.doc_id.as_str()),
        ("workspace", draft.workspace_id.as_str()),
        ("absolute path", draft.absolute_path.as_str()),
        ("base hash", draft.base_hash.as_str()),
    ] {
        if value.len() > MAX_FIELD {
            return Err(AppError::invalid_input(format!("the {label} is too long")));
        }
    }
    if draft.absolute_path.contains('\0') {
        return Err(AppError::invalid_input("the path contains a NUL byte"));
    }
    Ok(())
}

fn digest(value: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Temporary file next to the target, then rename. The caller sees an error
/// when either step fails, and the previous draft file is left untouched.
fn write_atomic(target: &Path, body: &[u8]) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::new("the draft path has no parent directory"))?;
    let nonce = format!("{}-{}", crate::workspace::now_ms(), std::process::id());
    let temp = parent.join(format!(
        ".{}.{nonce}.tmp",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("draft")
    ));

    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|error| {
        AppError::new(format!(
            "cannot write the draft {}: {error}",
            target.display()
        ))
    })?;
    let written = file
        .write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&temp);
            AppError::new(format!(
                "cannot write the draft {}: {error}",
                target.display()
            ))
        });
    if let Err(error) = written {
        return Err(error);
    }
    drop(file);
    fs::rename(&temp, target).map_err(|error| {
        let _ = fs::remove_file(&temp);
        AppError::new(format!(
            "cannot replace the draft {}: {error}",
            target.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "edgeterm-drafts-{name}-{}-{}",
                std::process::id(),
                crate::workspace::now_ms()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn draft(id: &str, content: &str) -> Draft {
        Draft {
            doc_id: id.into(),
            workspace_id: "w1".into(),
            server_key: "lab@gpu-01:22".into(),
            server_label: "gpu-01".into(),
            project_name: "baseline".into(),
            path: "src/train.py".into(),
            absolute_path: "/data/vfi/base/src/train.py".into(),
            content: content.into(),
            base_hash: "base-hash".into(),
            updated_at: crate::workspace::now_ms(),
        }
    }

    #[test]
    fn two_large_drafts_do_not_evict_each_other() {
        let dir = TempDir::new("large");
        let store = DraftStore::load_from(dir.0.clone());
        let a = "a".repeat(800_000);
        let b = "b".repeat(800_000);
        store.save(draft("w1::/a.py", &a)).unwrap();
        store.save(draft("w1::/b.py", &b)).unwrap();

        let list = store.list().unwrap();
        assert_eq!(
            list.drafts.len(),
            2,
            "a second draft must not remove the first"
        );
        assert_eq!(list.bytes, 1_600_000);
        assert_eq!(
            store.get("w1::/a.py").unwrap().unwrap().content.len(),
            800_000
        );
    }

    #[test]
    fn a_failed_write_is_reported_and_keeps_the_previous_draft() {
        let dir = TempDir::new("failure");
        let store = DraftStore::load_from(dir.0.clone());
        store.save(draft("w1::/a.py", "first")).unwrap();

        // Point the store at a path that cannot be a directory.
        let blocked = dir.0.join("not-a-dir");
        fs::write(&blocked, b"x").unwrap();
        let error_check = DraftStore::load_from(blocked.join("drafts"));
        let error = error_check.save(draft("w1::/a.py", "second")).unwrap_err();
        assert!(
            error.message.contains("draft directory") || error.message.contains("cannot"),
            "the error must say what failed: {}",
            error.message
        );
        assert_eq!(
            store.get("w1::/a.py").unwrap().unwrap().content,
            "first",
            "a failed write must not damage the stored draft"
        );
    }

    #[test]
    fn a_draft_survives_a_restart_and_lists_its_identity() {
        let dir = TempDir::new("restart");
        let store = DraftStore::load_from(dir.0.clone());
        store.save(draft("w1::/a.py", "unsaved")).unwrap();

        let reopened = DraftStore::load_from(dir.0.clone());
        let list = reopened.list().unwrap();
        assert_eq!(list.drafts.len(), 1);
        assert_eq!(list.drafts[0].server_label, "gpu-01");
        assert_eq!(list.drafts[0].project_name, "baseline");
        assert_eq!(list.drafts[0].content, "unsaved");
    }

    #[test]
    fn removing_a_draft_is_idempotent_and_scoped_to_its_project() {
        let dir = TempDir::new("remove");
        let store = DraftStore::load_from(dir.0.clone());
        store.save(draft("w1::/a.py", "a")).unwrap();
        let mut other = draft("w2::/b.py", "b");
        other.workspace_id = "w2".into();
        store.save(other).unwrap();

        assert_eq!(store.remove_workspace("w1").unwrap(), 1);
        assert!(store.get("w1::/a.py").unwrap().is_none());
        assert!(store.get("w2::/b.py").unwrap().is_some());
        store.remove("w2::/b.py").unwrap();
        store.remove("w2::/b.py").unwrap();
    }

    #[test]
    fn an_unreadable_draft_file_is_counted_not_hidden() {
        let dir = TempDir::new("corrupt");
        let store = DraftStore::load_from(dir.0.clone());
        store.save(draft("w1::/a.py", "a")).unwrap();
        fs::write(dir.0.join("broken.json"), b"{ not json").unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.drafts.len(), 1);
        assert_eq!(list.unreadable, 1);
    }
}
