use super::*;

pub type TransferResult<T> = std::result::Result<T, Failure>;

pub const EVENT: &str = "transfer:changed";

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl Failure {
    pub fn new(code: &str, message: impl ToString, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
            retryable,
        }
    }
    pub fn conflict(message: impl ToString) -> Self {
        Self::new("conflict", message, false)
    }
    pub fn local(message: impl ToString) -> Self {
        Self::new("local", message, false)
    }
    pub fn network(message: impl ToString) -> Self {
        Self::new("network", message, true)
    }
    pub fn connection(message: impl ToString) -> Self {
        let message = message.to_string();
        let lower = message.to_lowercase();
        let authentication = [
            "authentication",
            "password",
            "private key",
            "passphrase",
            "host key",
        ]
        .iter()
        .any(|word| lower.contains(word));
        Self::new(
            if authentication {
                "authentication"
            } else {
                "connection"
            },
            message,
            !authentication,
        )
    }
    pub fn stopped(&self) -> bool {
        matches!(self.code.as_str(), "paused" | "cancelled")
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        let retry = matches!(
            e.kind(),
            std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::NotConnected
        );
        Self::new(if retry { "network" } else { "local" }, e, retry)
    }
}

impl From<Failure> for AppError {
    fn from(e: Failure) -> Self {
        AppError::new(e.message)
    }
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "TransferItem"))]
pub struct Item {
    pub local: String,
    pub remote: String,
    pub upload: bool,
    #[serde(default)]
    pub directory: bool,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "TransferOptions"))]
pub struct Options {
    pub requests: usize,
    pub chunk_kib: usize,
    pub files: usize,
    /// Flush every uploaded file on the server's disk (fsync@openssh.com)
    /// before committing it. Off by default: the flush waits for the
    /// server's disk on every file and paces small-file batches. Unsupported
    /// servers reject uploads with this enabled. A flush is separate from
    /// replacement atomicity: the two-rename fallback has a visibility gap.
    #[serde(default)]
    pub durable: bool,
    /// Pack a folder upload into a tar archive and stream it into
    /// `tar -xf -` on the server, instead of writing every file over SFTP.
    /// Off by default, and nothing else in the engine looks at it. It covers
    /// one folder upload into a target directory that is absent or empty,
    /// needs a remote `tar` and a POSIX shell, and gives up the per-file
    /// resume, atomic commit, conflict detection and progress the SFTP path
    /// has — see `tar` for the full boundary list.
    #[serde(default)]
    pub tar: bool,
    /// Whole-job rate limit on the network payload a job moves, in bytes
    /// per second, shared by every wire path it runs (SFTP read/write
    /// requests, FTP data sockets, the tar pipe, and the remote read-back
    /// a resume verifies with). Protocol control messages and purely local
    /// disk work — source signatures, local prefix hashing — are not
    /// counted; the bytes are charged once, where they cross the wire.
    /// Zero means unlimited. A slice's tokens are taken exactly when it
    /// starts moving, short DATA and EOF reads give their unused tokens
    /// back, and waits never reserve future budget, so pausing or
    /// cancelling mid-wait leaves no debt behind. The burst is bounded by
    /// one second of budget (capped at 1 MiB), and low-rate jobs move in
    /// ~100 ms slices instead of whole chunks.
    #[serde(default)]
    pub rate_limit_bps: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            requests: 32,
            chunk_kib: 128,
            files: 16,
            durable: false,
            tar: false,
            rate_limit_bps: 0,
        }
    }
}

impl Options {
    pub fn validate(&self) -> Result<()> {
        if !(1..=32).contains(&self.requests)
            || !(16..=256).contains(&self.chunk_kib)
            || !(1..=32).contains(&self.files)
        {
            return Err(AppError::new("invalid transfer concurrency or chunk size"));
        }
        // The floor keeps one pacing slice's wait inside the operation
        // timeout budget; the ceiling keeps the nanosecond math exact.
        if self.rate_limit_bps != 0 && !(1024..=1 << 30).contains(&self.rate_limit_bps) {
            return Err(AppError::new(
                "transfer rate limit must be 0 (unlimited) or 1 KiB/s to 1 GiB/s",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Checkpoint {
    pub key: String,
    pub item: Item,
    pub source: Signature,
    pub original: Option<Signature>,
    pub temporary: String,
    pub backup: String,
    pub offset: u64,
    pub prefix_hash: String,
    pub complete: bool,
    pub committing: bool,
    pub owns_temporary: bool,
    pub owns_backup: bool,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "FileTransfer"))]
#[cfg_attr(feature = "bindings", derive(tauri_specta::Event))]
#[cfg_attr(feature = "bindings", tauri_specta(event_name = "transfer:changed"))]
pub struct Snapshot {
    pub revision: u64,
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub context: Option<TransferContext>,
    pub status: String,
    pub phase: String,
    pub transferred: u64,
    pub total: u64,
    pub completed_files: usize,
    pub total_files: usize,
    pub failed_files: Vec<String>,
    pub error: Option<Failure>,
    pub attempt: usize,
    pub options: Options,
}

/// Display identity captured at submission, independent of the lifetime of a tab.
/// Only the first chosen pair is included so large selections keep events bounded.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferContext {
    pub server: String,
    pub protocol: String,
    pub local: String,
    pub remote: String,
    pub first_upload: bool,
    pub item_count: usize,
    pub direction: String,
}

impl TransferContext {
    pub(super) fn new(profile: &SessionProfile, items: &[Item]) -> Option<Self> {
        let first_item = items.first()?.clone();
        let ftp = profile.kind == SessionKind::Ftp;
        let host = profile.host.as_deref().unwrap_or("");
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.into()
        };
        let user = profile.username.as_deref().filter(|user| !user.is_empty());
        Some(Self {
            server: format!(
                "{}{host}:{}",
                user.map(|user| format!("{user}@")).unwrap_or_default(),
                profile.port.unwrap_or(if ftp { 21 } else { 22 })
            ),
            protocol: if ftp { "FTP" } else { "SFTP" }.into(),
            direction: if items.iter().any(|item| item.upload != first_item.upload) {
                "mixed"
            } else if first_item.upload {
                "upload"
            } else {
                "download"
            }
            .into(),
            local: first_item.local,
            remote: first_item.remote,
            first_upload: first_item.upload,
            item_count: items.len(),
        })
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[test]
    fn context_keeps_bounded_paths_and_identity_without_credentials() {
        let profile: SessionProfile = serde_json::from_value(serde_json::json!({
            "name": "lab", "kind": "ssh", "host": "::1", "port": 2222,
            "username": "tester", "password": "private-test-password"
        }))
        .unwrap();
        let items: Vec<Item> = serde_json::from_value(serde_json::json!([
            {"local": "C:/first", "remote": "/srv/first", "upload": true},
            {"local": "C:/second", "remote": "/srv/second", "upload": false}
        ]))
        .unwrap();
        let context = TransferContext::new(&profile, &items).unwrap();
        assert_eq!(context.server, "tester@[::1]:2222");
        assert_eq!(context.protocol, "SFTP");
        assert_eq!(context.item_count, 2);
        assert_eq!(context.direction, "mixed");
        assert_eq!(context.remote, "/srv/first");
        let json = serde_json::to_string(&context).unwrap();
        assert!(!json.contains("private-test-password"));
        assert!(!json.contains("/srv/second"));
    }

    #[test]
    fn payload_progress_replaces_another_files_commit_phase() {
        let root = std::env::temp_dir().join(format!("edgeterm-phase-{}", uuid::Uuid::new_v4()));
        let job = test_job(root.clone());
        job.phase("committing");
        job.progress("other", 64, 128, false);
        assert_eq!(job.snapshot.lock().phase, "transferring");
        drop(job);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// A journal as it comes back off disk, checkpoints verified.
#[derive(Clone)]
pub struct PersistedJournal {
    pub id: String,
    pub kind: String,
    pub endpoint: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// The journal's top-level rows, as the user chose them.
    pub items: Vec<Item>,
    /// The frozen plan when one was saved; `None` when the job was
    /// interrupted before planning. A resumed job re-plans from `items`
    /// then — top-level folder rows must never run as though they were a
    /// plan of files.
    pub plan: Option<Vec<Item>>,
    pub options: Options,
    pub checkpoints: HashMap<String, Checkpoint>,
}

/// What the Restart Recovery list shows for one directory under
/// `transfers/`.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recoverable {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub endpoint: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub items: usize,
    pub checkpoints: usize,
    /// Set when the directory exists but its journal cannot be attributed;
    /// such an entry can only be discarded, never resumed.
    pub unrecognized: bool,
}
