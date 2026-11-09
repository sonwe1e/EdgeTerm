//! Remote files opened in a local application. The front end downloads the
//! file to a temp location and launches the application; from then on the
//! local copy is watched through the OS file notification API and uploaded
//! back over the session's SFTP channel as soon as it is saved, so saving in
//! the editor updates the file on the server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use parking_lot::{Mutex, MutexGuard};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::commands::AppState;
use crate::error::{err, AppError, Result};
use crate::session::transfer::safe_local_child;
use crate::session::{SessionManager, TransferProgress};

pub const EVENT_REMOTE_EDIT: &str = "remote-edit:state";

/// Marks a leftover copy that still holds changes which never reached the
/// server, so `clean_leftovers` leaves it for the user.
const UNSYNCED_MARKER: &str = ".unsynced";
/// An active editor can save before the watcher receives its notification.
/// Keep its copy after a crash even if no dirty flag was observed in time.
const ACTIVE_MARKER: &str = ".active";

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditPath {
    pub path: String,
    pub reused: bool,
}

type Snapshot = (SystemTime, u64);

/// One save produces a burst of notifications (editors truncate, write and
/// rename in steps); the upload starts once the burst has been quiet for
/// this long.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Pause after a failed upload before the change is tried again; doubles up
/// to `MAX_RETRY_DELAY` while the failures continue.
const RETRY_DELAY: Duration = Duration::from_secs(3);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(tauri_specta::Event))]
#[cfg_attr(feature = "bindings", tauri_specta(event_name = "remote-edit:state"))]
pub struct RemoteEditEvent {
    pub session_id: String,
    pub remote_path: String,
    pub name: String,
    /// `uploading`, `synced`, `error`, or `kept` when the watch ended with
    /// changes still unsent and the local copy was left in place.
    pub status: &'static str,
    pub message: Option<String>,
}

struct Watched {
    local: PathBuf,
    task: JoinHandle<()>,
    /// Set while the copy holds a save that has not reached the server.
    dirty: Arc<AtomicBool>,
    /// The last local state confirmed uploaded, captured before the local
    /// application is opened rather than when the async loop first runs.
    baseline: Arc<Mutex<Option<Snapshot>>>,
    /// Dropping it ends the OS subscription.
    _watcher: RecommendedWatcher,
}

/// Every local copy lives in its own folder under here.
fn edit_root() -> PathBuf {
    std::env::temp_dir().join("EdgeTerm").join("edit")
}

/// Removes the copies a previous run left behind (it quit or crashed while
/// editors still had them open), except those flagged as holding unsent
/// changes. Run once at startup, before any watch of this run exists.
pub fn clean_leftovers() {
    clean_leftovers_in(&edit_root());
}

fn clean_leftovers_in(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.join(UNSYNCED_MARKER).exists() || dir.join(ACTIVE_MARKER).exists() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            eprintln!("EdgeTerm: could not remove {}: {error}", dir.display());
        }
    }
}

fn mark_active(local: &Path) -> Result<()> {
    let dir = local
        .parent()
        .ok_or_else(|| AppError::new(format!("{} has no parent folder", local.display())))?;
    if local
        .file_name()
        .is_some_and(|name| name == ACTIVE_MARKER || name == UNSYNCED_MARKER)
    {
        return Err(AppError::invalid_input(
            "the editable copy uses a reserved marker name",
        ));
    }
    write_marker(dir, ACTIVE_MARKER)
}

fn write_marker(dir: &Path, name: &str) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(dir.join(name)) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(err(error)),
    }
}

/// Closing may beat the notification's debounce. Compare the file itself as
/// well as the flag, and retain an uncertain/missing snapshot conservatively.
fn retain_copy(local: &Path, dirty: bool, baseline: Option<Snapshot>) -> bool {
    dirty || baseline.is_none() || snapshot(local) != baseline
}

fn finish_copy(local: &Path, dirty: bool, baseline: Option<Snapshot>) -> bool {
    let Some(dir) = local.parent() else {
        return true;
    };
    let keep = retain_copy(local, dirty, baseline);
    if keep {
        // The active marker remains if writing this more precise marker
        // fails; startup cleanup must still leave this copy alone.
        let _ = write_marker(dir, UNSYNCED_MARKER);
    } else if let Err(error) = std::fs::remove_dir_all(dir) {
        eprintln!("EdgeTerm: could not remove {}: {error}", dir.display());
    }
    keep
}

/// Ends a watch for good. A copy whose every save reached the server is
/// deleted along with its folder; one with unsent changes is kept and
/// flagged, and reported so the user knows where it is.
fn discard(app: &AppHandle, key: &(String, String), watched: Watched) {
    watched.task.abort();
    drop(watched._watcher);
    let baseline = *watched.baseline.lock();
    if finish_copy(
        &watched.local,
        watched.dirty.load(Ordering::Relaxed),
        baseline,
    ) {
        let name = watched
            .local
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = app.emit(
            EVENT_REMOTE_EDIT,
            RemoteEditEvent {
                session_id: key.0.clone(),
                remote_path: key.1.clone(),
                name,
                status: "kept",
                message: Some(format!(
                    "changes never reached the server; the local copy is kept at {}",
                    watched.local.display()
                )),
            },
        );
    }
}

/// Watched files keyed by session id and remote path.
#[derive(Default)]
pub struct RemoteEdits {
    watchers: Mutex<HashMap<(String, String), Watched>>,
}

impl RemoteEdits {
    /// Hold the registry through the liveness check and insertion. Tab close
    /// removes its SessionManager handle before stop_session takes this same
    /// lock: a concurrent watch is either drained by stop or rejected here.
    fn watchers_for_session(
        &self,
        sessions: &SessionManager,
        session_id: &str,
    ) -> Result<MutexGuard<'_, HashMap<(String, String), Watched>>> {
        let watchers = self.watchers.lock();
        if !sessions.is_open(session_id) {
            return Err(AppError::new(format!("session {session_id} is not open")));
        }
        Ok(watchers)
    }

    /// Where the local copy of `remote` lives: the copy already being watched
    /// (so reopening a file lands in the same place), otherwise a fresh
    /// directory under the OS temp folder — one per file, so equal names from
    /// different folders cannot collide.
    ///
    /// A watched copy is reused without another download: it may hold a save
    /// still waiting for upload. The caller only downloads and starts a
    /// watcher for a fresh path (`reused == false`).
    pub fn local_path(&self, session_id: &str, remote: &str, name: &str) -> Result<RemoteEditPath> {
        self.local_path_in(&edit_root(), session_id, remote, name)
    }

    fn local_path_in(
        &self,
        root: &Path,
        session_id: &str,
        remote: &str,
        name: &str,
    ) -> Result<RemoteEditPath> {
        let key = (session_id.to_string(), remote.to_string());
        if let Some(watched) = self.watchers.lock().get(&key) {
            return Ok(RemoteEditPath {
                path: watched.local.to_string_lossy().into_owned(),
                reused: true,
            });
        }
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        // A remote dotfile must never collide with our empty lifecycle marker.
        let local_name = if matches!(name, ACTIVE_MARKER | UNSYNCED_MARKER) {
            format!("_{name}")
        } else {
            name.to_string()
        };
        let path = safe_local_child(&dir, &local_name)?;
        std::fs::create_dir_all(&dir).map_err(err)?;
        Ok(RemoteEditPath {
            path: path.to_string_lossy().into_owned(),
            reused: false,
        })
    }

    /// Starts uploading `local` to `remote` whenever it is saved, replacing
    /// any earlier watcher of the same remote file. The current state of the
    /// local copy is the baseline — it has just been downloaded — so nothing
    /// goes out until the user saves.
    pub fn watch(
        &self,
        app: AppHandle,
        session_id: String,
        local: PathBuf,
        remote: String,
    ) -> Result<()> {
        let key = (session_id.clone(), remote.clone());
        let state = app.state::<AppState>();
        let mut watchers = self.watchers_for_session(&state.sessions, &session_id)?;
        if watchers
            .get(&key)
            .is_some_and(|watched| watched.local == local)
        {
            return Ok(());
        }
        let dir = local
            .parent()
            .ok_or_else(|| AppError::new(format!("{} has no parent folder", local.display())))?;
        let baseline = snapshot(&local)
            .ok_or_else(|| AppError::new("the downloaded copy is not a readable regular file"))?;
        // Written only for a completed editable download, before launching
        // its application. No source path or file content enters the marker.
        mark_active(&local)?;

        let (tx, rx) = mpsc::unbounded_channel();
        // Every notification from the folder counts, whatever path it names:
        // the folder holds only this file, and the mtime / size check in the
        // loop sorts out the rest (an editor's swap or backup file, the
        // folder itself, a replayed history). Matching the file name here
        // would be fragile — a file system may report it in another case
        // or Unicode normalization than the one it was created with.
        let handler = move |event: notify::Result<Event>| {
            if event.is_ok() {
                let _ = tx.send(());
            }
        };
        let mut watcher =
            RecommendedWatcher::new(handler, notify::Config::default()).map_err(err)?;
        // The folder rather than the file: editors that save by writing a new
        // file and renaming it over the old one replace the inode, and a
        // watch on the old inode would go stale after the first save.
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(err)?;

        let dirty = Arc::new(AtomicBool::new(false));
        let baseline = Arc::new(Mutex::new(Some(baseline)));
        let task = tauri::async_runtime::spawn(watch_loop(
            app.clone(),
            session_id,
            local.clone(),
            remote,
            rx,
            Arc::clone(&dirty),
            Arc::clone(&baseline),
        ));
        let previous = watchers.insert(
            key.clone(),
            Watched {
                local,
                task,
                dirty,
                baseline,
                _watcher: watcher,
            },
        );
        drop(watchers);
        if let Some(previous) = previous {
            discard(&app, &key, previous);
        }
        Ok(())
    }

    /// Stops every watcher of a session and removes its synced copies. Called
    /// when the tab is closed for good; a plain disconnect keeps them, so a
    /// save made while offline is sent once the tab reconnects (reconnects
    /// reuse the session id).
    pub fn stop_session(&self, app: &AppHandle, session_id: &str) {
        for (key, watched) in self.take_session(session_id) {
            discard(app, &key, watched);
        }
    }

    fn take_session(&self, session_id: &str) -> Vec<((String, String), Watched)> {
        let mut watchers = self.watchers.lock();
        let keys: Vec<_> = watchers
            .keys()
            .filter(|(id, _)| id == session_id)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| watchers.remove(&key).map(|watched| (key, watched)))
            .collect()
    }

    /// Stops everything and removes the synced copies; for application exit.
    pub fn stop_all(&self, app: &AppHandle) {
        let stopped: Vec<_> = self.watchers.lock().drain().collect();
        for (key, watched) in stopped {
            discard(app, &key, watched);
        }
    }
}

/// Modification time and size, to tell a save from a notification that
/// changed nothing (an attribute touch, the editor's own re-read). None while
/// the file is missing, which happens for a moment when an editor replaces it.
fn snapshot(path: &Path) -> Option<Snapshot> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((metadata.modified().ok()?, metadata.len()))
}

async fn watch_loop(
    app: AppHandle,
    session_id: String,
    local: PathBuf,
    remote: String,
    mut events: mpsc::UnboundedReceiver<()>,
    dirty: Arc<AtomicBool>,
    baseline: Arc<Mutex<Option<Snapshot>>>,
) {
    let name = remote.rsplit('/').next().unwrap_or(&remote).to_string();
    let emit = |status: &'static str, message: Option<String>| {
        let _ = app.emit(
            EVENT_REMOTE_EDIT,
            RemoteEditEvent {
                session_id: session_id.clone(),
                remote_path: remote.clone(),
                name: name.clone(),
                status,
                message,
            },
        );
    };

    // While set, the copy holds a save that has not reached the server: it
    // is retried after a pause, or sooner if the file is saved again, and
    // `discard` knows not to delete the copy.
    let unsent = |flag: bool| dirty.store(flag, Ordering::Relaxed);
    let is_unsent = || dirty.load(Ordering::Relaxed);
    let mut retry_delay = RETRY_DELAY;
    // The same failure (typically "session not found" while disconnected) is
    // reported once, not on every retry.
    let mut last_error: Option<String> = None;
    let mut pending: Option<((SystemTime, u64), Arc<crate::file_transfer::Job>)> = None;

    loop {
        // Sleep until the next notification. A None means the watcher was
        // dropped, i.e. this watch has been stopped.
        let notified = if is_unsent() {
            match timeout(retry_delay, events.recv()).await {
                Ok(Some(())) => true,
                Ok(None) => return,
                Err(_) => false,
            }
        } else {
            match events.recv().await {
                Some(()) => true,
                None => return,
            }
        };
        if notified {
            // Let the rest of the save's burst arrive before looking at the file.
            loop {
                match timeout(DEBOUNCE, events.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
        }

        let Some(current) = snapshot(&local) else {
            continue;
        };
        if !is_unsent() && Some(current) == *baseline.lock() {
            continue;
        }
        unsent(true);

        emit("uploading", None);
        let state = app.state::<AppState>();
        if pending
            .as_ref()
            .is_some_and(|(source, _)| *source != current)
        {
            let (_, previous) = pending.take().unwrap();
            if state.file_transfers.control(&previous.id, "cancel").is_ok() {
                let _ = crate::file_transfer::wait(&previous).await;
                let _ = state.file_transfers.control(&previous.id, "dismiss");
            }
        }
        let outcome = if let Some((_, job)) = &pending {
            match state.file_transfers.control(&job.id, "retry") {
                Ok(()) => crate::file_transfer::wait(job).await,
                Err(error) => Err(error),
            }
        } else {
            match state.file_transfers.start(
                Some(app.clone()),
                session_id.clone(),
                vec![crate::file_transfer::Item {
                    local: local.to_string_lossy().into_owned(),
                    remote: remote.clone(),
                    upload: true,
                    directory: false,
                }],
                None,
                Default::default(),
                Channel::<TransferProgress>::new(|_| Ok(())),
            ) {
                Ok(job) => {
                    pending = Some((current, job.clone()));
                    crate::file_transfer::wait(&job).await
                }
                Err(error) => Err(error),
            }
        };
        match outcome {
            Ok(_) => {
                if let Some((_, job)) = pending.take() {
                    let _ = state.file_transfers.control(&job.id, "dismiss");
                }
                *baseline.lock() = Some(current);
                unsent(false);
                retry_delay = RETRY_DELAY;
                last_error = None;
                emit("synced", None);
            }
            Err(error) => {
                let message = error.to_string();
                if last_error.as_deref() != Some(message.as_str()) {
                    emit("error", Some(message.clone()));
                    last_error = Some(message);
                }
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("edgeterm-remote-edit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn live_session(
        id: &str,
    ) -> (
        crate::session::SessionManager,
        mpsc::UnboundedReceiver<crate::session::SessionCommand>,
    ) {
        let sessions = crate::session::SessionManager::default();
        let (tx, rx) = mpsc::unbounded_channel();
        sessions.insert(crate::session::SessionHandle {
            info: crate::model::SessionInfo {
                id: id.to_string(),
                profile_id: None,
                name: "test".into(),
                kind: crate::model::SessionKind::Ssh,
                protocol: "ssh".into(),
                address: "example.test:22".into(),
                color: None,
                supports_remote_files: true,
                recording: None,
                legacy_algorithms: Vec::new(),
                shared_connection: false,
            },
            tx,
            encoding: encoding_rs::UTF_8,
            owner_thread: None,
        });
        (sessions, rx)
    }

    #[test]
    fn watch_registration_rejects_removed_or_terminated_sessions() {
        let edits = RemoteEdits::default();
        let (sessions, receiver) = live_session("editing");
        assert!(edits.watchers_for_session(&sessions, "missing").is_err());
        assert!(edits.watchers_for_session(&sessions, "editing").is_ok());

        drop(receiver);
        assert!(edits.watchers_for_session(&sessions, "editing").is_err());
        sessions.remove("editing");
        assert!(edits.watchers_for_session(&sessions, "editing").is_err());
        assert!(edits.watchers.lock().is_empty());
    }

    #[test]
    fn registration_guard_keeps_stop_ordered_until_the_watch_is_inserted() {
        let root = TempRoot::new();
        let edits = RemoteEdits::default();
        let (sessions, _receiver) = live_session("editing");
        let local = root.0.join("notes.txt");
        std::fs::write(&local, b"downloaded").unwrap();
        let baseline = snapshot(&local);
        let key = ("editing".to_string(), "/notes.txt".to_string());
        let mut registering = edits.watchers_for_session(&sessions, "editing").unwrap();
        assert!(edits.watchers.try_lock().is_none());
        // close_session can remove the connection meanwhile; stop_session
        // still takes this same registry lock, after the insertion finishes.
        sessions.remove("editing");
        registering.insert(
            key,
            Watched {
                local,
                task: tauri::async_runtime::spawn(std::future::pending::<()>()),
                dirty: Arc::new(AtomicBool::new(false)),
                baseline: Arc::new(Mutex::new(baseline)),
                _watcher: RecommendedWatcher::new(|_| {}, notify::Config::default()).unwrap(),
            },
        );
        drop(registering);
        let stopped = edits.take_session("editing");
        assert_eq!(stopped.len(), 1);
        for (_, watched) in stopped {
            watched.task.abort();
        }
        // The opposite order (close/stop first, download returns later) may
        // not resurrect the registry, even under the same tab id.
        assert!(edits.watchers_for_session(&sessions, "editing").is_err());
        assert!(edits.watchers.lock().is_empty());
    }

    #[test]
    fn local_path_isolates_folders_and_rejects_unsafe_names() {
        let root = TempRoot::new();
        let edits = RemoteEdits::default();

        let first = edits
            .local_path_in(&root.0, "s1", "/etc/app/config.toml", "config.toml")
            .unwrap();
        let second = edits
            .local_path_in(&root.0, "s1", "/var/app/config.toml", "config.toml")
            .unwrap();

        assert!(!first.reused);
        assert!(!second.reused);
        assert_eq!(Path::new(&first.path).file_name().unwrap(), "config.toml");
        assert_eq!(Path::new(&second.path).file_name().unwrap(), "config.toml");
        assert_ne!(
            Path::new(&first.path).parent().unwrap(),
            Path::new(&second.path).parent().unwrap()
        );

        for unsafe_name in ["", ".", "..", "../secret", "sub/file.txt", "sub\\file.txt"] {
            assert!(
                edits
                    .local_path_in(&root.0, "s1", "/etc/app/file", unsafe_name)
                    .is_err(),
                "expected {unsafe_name:?} to be rejected"
            );
        }
    }

    #[test]
    fn reopening_reuses_the_watched_draft_without_stopping_its_watch() {
        let root = TempRoot::new();
        let edits = RemoteEdits::default();
        let prepared = edits
            .local_path_in(&root.0, "s1", "/notes.txt", "notes.txt")
            .unwrap();
        let local = PathBuf::from(&prepared.path);
        std::fs::write(&local, b"downloaded").unwrap();
        let baseline = Arc::new(Mutex::new(snapshot(&local)));
        mark_active(&local).unwrap();
        std::fs::write(&local, b"local draft waiting for upload").unwrap();
        let dirty = Arc::new(AtomicBool::new(true));
        let task = tauri::async_runtime::spawn(std::future::pending::<()>());
        let watcher = RecommendedWatcher::new(|_| {}, notify::Config::default()).unwrap();
        let key = ("s1".to_string(), "/notes.txt".to_string());
        edits.watchers.lock().insert(
            key.clone(),
            Watched {
                local: local.clone(),
                task,
                dirty: Arc::clone(&dirty),
                baseline,
                _watcher: watcher,
            },
        );

        let reopened = edits
            .local_path_in(&root.0, "s1", "/notes.txt", "notes.txt")
            .unwrap();
        assert!(reopened.reused);
        assert_eq!(reopened.path, prepared.path);
        assert_eq!(
            std::fs::read(&local).unwrap(),
            b"local draft waiting for upload"
        );
        let watched = edits
            .watchers
            .lock()
            .remove(&key)
            .expect("watch kept alive");
        assert!(Arc::ptr_eq(&watched.dirty, &dirty));
        assert!(dirty.load(Ordering::Relaxed));
        watched.task.abort();
    }

    #[test]
    fn close_before_debounce_preserves_a_save_without_a_dirty_notification() {
        let root = TempRoot::new();
        let dir = root.0.join("editable");
        std::fs::create_dir_all(&dir).unwrap();
        let local = dir.join("notes.txt");
        std::fs::write(&local, b"downloaded").unwrap();
        let baseline = snapshot(&local);
        mark_active(&local).unwrap();
        std::fs::write(&local, b"saved just before closing the tab").unwrap();

        assert!(finish_copy(&local, false, baseline));
        clean_leftovers_in(&root.0);
        assert_eq!(
            std::fs::read(&local).unwrap(),
            b"saved just before closing the tab"
        );
        assert!(dir.join(UNSYNCED_MARKER).exists());
    }

    #[test]
    fn verified_synced_close_removes_its_active_copy() {
        let root = TempRoot::new();
        let dir = root.0.join("editable");
        std::fs::create_dir_all(&dir).unwrap();
        let local = dir.join("notes.txt");
        std::fs::write(&local, b"uploaded").unwrap();
        mark_active(&local).unwrap();
        assert!(!finish_copy(&local, false, snapshot(&local)));
        assert!(!dir.exists());
    }

    #[test]
    fn marker_names_cannot_overwrite_remote_dotfile_contents() {
        let root = TempRoot::new();
        let edits = RemoteEdits::default();
        for name in [ACTIVE_MARKER, UNSYNCED_MARKER] {
            let prepared = edits.local_path_in(&root.0, "s1", name, name).unwrap();
            let local = Path::new(&prepared.path);
            std::fs::write(local, b"remote dotfile contents").unwrap();
            mark_active(local).unwrap();
            assert!(finish_copy(local, true, snapshot(local)));
            clean_leftovers_in(&root.0);
            assert_eq!(std::fs::read(local).unwrap(), b"remote dotfile contents");
        }
    }

    #[test]
    fn clean_leftovers_removes_synced_folders_and_preserves_unsynced_copies() {
        let root = TempRoot::new();
        let synced = root.0.join("synced-copy");
        let unsynced = root.0.join("unsynced-copy");
        let active = root.0.join("active-at-crash");
        std::fs::create_dir_all(&synced).unwrap();
        std::fs::create_dir_all(&unsynced).unwrap();
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(synced.join("notes.txt"), b"already uploaded").unwrap();
        std::fs::write(unsynced.join("notes.txt"), b"local draft").unwrap();
        std::fs::write(unsynced.join(UNSYNCED_MARKER), b"").unwrap();
        std::fs::write(active.join("notes.txt"), b"save not yet notified").unwrap();
        mark_active(&active.join("notes.txt")).unwrap();

        clean_leftovers_in(&root.0);

        assert!(!synced.exists());
        assert!(unsynced.exists());
        assert_eq!(
            std::fs::read(active.join("notes.txt")).unwrap(),
            b"save not yet notified"
        );
        assert_eq!(
            std::fs::read(unsynced.join("notes.txt")).unwrap(),
            b"local draft"
        );
    }

    #[test]
    fn snapshot_tracks_missing_files_and_content_size_changes() {
        let root = TempRoot::new();
        let file = root.0.join("sample.txt");

        assert_eq!(snapshot(&file), None);

        std::fs::write(&file, b"one").unwrap();
        let before = snapshot(&file).expect("snapshot of existing file");
        assert_eq!(before.1, 3);

        std::fs::write(&file, b"three").unwrap();
        let after = snapshot(&file).expect("snapshot after write");
        assert_eq!(after.1, 5);
        assert_ne!(before, after);
    }
}
