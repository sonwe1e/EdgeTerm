//! Background file jobs. Credentials stay in memory; journals contain only
//! endpoint identity, paths, source fingerprints and confirmed checkpoints.
mod ftp;
mod local;
mod sftp;

use std::collections::HashMap;
use std::future::Future;
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};
use tokio::sync::{watch, Semaphore};

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::model::{SessionKind, SessionProfile};
use crate::session::{ssh::SharedTransport, TransferProgress};
use local::Signature;

pub type TransferResult<T> = std::result::Result<T, Failure>;
pub const EVENT: &str = "transfer:changed";

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

/// A watch channel closes the check/sleep race and wakes blocked async I/O.
/// Registered FTP sockets are interrupted as well, so blocking workers stop.
pub struct Control {
    state: watch::Sender<u8>,
    sockets: Mutex<HashMap<usize, TcpStream>>,
    serial: AtomicUsize,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            state: watch::channel(0).0,
            sockets: Mutex::new(HashMap::new()),
            serial: AtomicUsize::new(0),
        }
    }
}
pub struct SocketGuard<'a> {
    control: &'a Control,
    id: usize,
}
impl Drop for SocketGuard<'_> {
    fn drop(&mut self) {
        self.control.sockets.lock().remove(&self.id);
    }
}
impl Control {
    pub fn value(&self) -> u8 {
        *self.state.borrow()
    }
    pub fn set(&self, value: u8) {
        self.state.send_replace(value);
        if value != 0 {
            for socket in self.sockets.lock().values() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
    pub fn check(&self) -> TransferResult<()> {
        match self.value() {
            1 => Err(Failure::new("paused", "transfer paused", false)),
            2 => Err(Failure::new("cancelled", "transfer cancelled", false)),
            _ => Ok(()),
        }
    }
    pub async fn stopped(&self) {
        let mut rx = self.state.subscribe();
        while *rx.borrow_and_update() == 0 {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
    async fn resumed(&self) {
        let mut rx = self.state.subscribe();
        while *rx.borrow_and_update() == 1 {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
    pub async fn run<T>(
        &self,
        future: impl Future<Output = TransferResult<T>>,
    ) -> TransferResult<T> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.stopped() => { self.check()?; unreachable!() },
            result = tokio::time::timeout(Duration::from_secs(30), future) =>
                result.unwrap_or_else(|_| Err(Failure::new("timeout", "transfer operation timed out", true))),
        }
    }
    pub fn socket(&self, stream: &TcpStream) -> TransferResult<SocketGuard<'_>> {
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;
        let clone = stream.try_clone()?;
        let mut sockets = self.sockets.lock();
        self.check()?;
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        sockets.insert(id, clone);
        Ok(SocketGuard { control: self, id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub local: String,
    pub remote: String,
    pub upload: bool,
    #[serde(default)]
    pub directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}
impl Default for Options {
    fn default() -> Self {
        Self {
            requests: 32,
            chunk_kib: 128,
            files: 8,
            durable: false,
        }
    }
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if !(1..=32).contains(&self.requests)
            || !(16..=256).contains(&self.chunk_kib)
            || !(1..=16).contains(&self.files)
        {
            return Err(AppError::new("invalid transfer concurrency or chunk size"));
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub id: String,
    pub session_id: String,
    pub name: String,
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

pub struct Job {
    pub id: String,
    pub session_id: String,
    pub items: Vec<Item>,
    pub options: Options,
    pub profile: SessionProfile,
    pub jumps: Vec<SessionProfile>,
    pub transport: Mutex<Option<Arc<SharedTransport>>>,
    pub control: Arc<Control>,
    pub checkpoints: Mutex<HashMap<String, Checkpoint>>,
    pub directory: PathBuf,
    snapshot: Mutex<Snapshot>,
    progress: Mutex<HashMap<String, (u64, u64, bool)>>,
    last_emit: Mutex<Instant>,
    app: Option<AppHandle>,
    targets: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    plan: Mutex<Option<Vec<Item>>>,
    lifecycle: Mutex<()>,
    channel: Channel<TransferProgress>,
    active: AtomicBool,
    done: watch::Sender<Option<std::result::Result<(), String>>>,
}

impl Job {
    pub async fn lock_target(
        &self,
        item: &Item,
    ) -> TransferResult<tokio::sync::OwnedMutexGuard<()>> {
        let target = target_key(&self.profile, item);
        let lock = self
            .targets
            .lock()
            .entry(target)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        tokio::select! {
            _ = self.control.stopped() => { self.control.check()?; unreachable!() },
            guard = lock.lock_owned() => Ok(guard),
        }
    }
    pub fn key(&self, item: &Item) -> String {
        local::digest(
            format!(
                "{}\0{}\0{}\0{}",
                self.id, item.local, item.remote, item.upload
            )
            .as_bytes(),
        )[..24]
            .into()
    }
    pub fn checkpoint(&self, key: &str) -> Option<Checkpoint> {
        self.checkpoints.lock().get(key).cloned()
    }
    pub fn save(&self, checkpoint: &Checkpoint) -> TransferResult<()> {
        local::save_json(
            &self.directory.join(format!("{}.json", checkpoint.key)),
            checkpoint,
        )?;
        self.checkpoints
            .lock()
            .insert(checkpoint.key.clone(), checkpoint.clone());
        Ok(())
    }
    pub fn progress(&self, key: &str, offset: u64, total: u64, complete: bool) {
        let mut progress = self.progress.lock();
        let old = progress
            .insert(key.into(), (offset, total, complete))
            .unwrap_or((0, 0, false));
        let mut snapshot = self.snapshot.lock();
        snapshot.transferred = snapshot
            .transferred
            .saturating_sub(old.0)
            .saturating_add(offset);
        snapshot.total = snapshot.total.saturating_sub(old.1).saturating_add(total);
        snapshot.total_files = progress.len();
        snapshot.completed_files =
            snapshot.completed_files.saturating_sub(old.2 as usize) + complete as usize;
        drop(snapshot);
        drop(progress);
        self.emit(false);
    }
    pub fn phase(&self, phase: &str) {
        self.snapshot.lock().phase = phase.into();
        self.emit(false);
    }
    pub fn failure(&self, path: &str, error: &Failure) {
        let mut snapshot = self.snapshot.lock();
        snapshot
            .failed_files
            .push(format!("{path}: {}", error.message));
    }
    fn status(&self, status: &str, error: Option<Failure>) {
        let mut snapshot = self.snapshot.lock();
        snapshot.status = status.into();
        snapshot.error = error;
        drop(snapshot);
        self.emit(true);
    }
    fn emit(&self, force: bool) {
        let mut last = self.last_emit.lock();
        if !force && last.elapsed() < Duration::from_millis(100) {
            return;
        }
        *last = Instant::now();
        let mut current = self.snapshot.lock();
        current.revision += 1;
        let snapshot = current.clone();
        drop(current);
        let _ = self.channel.send(TransferProgress {
            transferred: snapshot.transferred,
            total: snapshot.total,
        });
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT, snapshot);
        }
    }
}

#[derive(Default)]
pub struct Transfers {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    profiles: Mutex<HashMap<String, SessionProfile>>,
    limits: Mutex<HashMap<String, Arc<Semaphore>>>,
    targets: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    early_cancels: Mutex<HashMap<String, Instant>>,
}
impl Transfers {
    pub fn remember(&self, id: &str, profile: &SessionProfile) {
        self.profiles.lock().insert(id.into(), profile.clone());
    }
    pub fn forget(&self, id: &str) {
        self.profiles.lock().remove(id);
    }
    pub fn snapshots(&self) -> Vec<Snapshot> {
        let mut jobs: Vec<_> = self
            .jobs
            .lock()
            .values()
            .map(|j| j.snapshot.lock().clone())
            .collect();
        jobs.sort_by(|a, b| a.id.cmp(&b.id));
        jobs
    }
    pub fn start(
        &self,
        app: AppHandle,
        session_id: String,
        items: Vec<Item>,
        id: Option<String>,
        options: Options,
        channel: Channel<TransferProgress>,
    ) -> Result<Arc<Job>> {
        options.validate()?;
        if items.is_empty()
            || items
                .iter()
                .any(|i| i.local.is_empty() || i.remote.is_empty())
        {
            return Err(AppError::new("empty transfer source or destination"));
        }
        let profile = self
            .profiles
            .lock()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| AppError::new("reconnect this session before starting a transfer"))?;
        let state = app.state::<AppState>();
        let jumps = state.store.jump_chain(&profile)?;
        let transport = state.ssh_transports.get(&session_id);
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(AppError::new("invalid transfer id"));
        }
        let root = crate::store::portable_data_dir()
            .unwrap_or_else(|| {
                dirs::config_dir()
                    .unwrap_or_else(std::env::temp_dir)
                    .join("EdgeTerm")
            })
            .join("transfers");
        let directory = root.join(&id);
        std::fs::create_dir_all(&root)?;
        std::fs::create_dir(&directory)?;
        let name = if items.len() == 1 {
            items[0]
                .remote
                .rsplit('/')
                .next()
                .unwrap_or("Transfer")
                .to_string()
        } else {
            format!("{} items", items.len())
        };
        // No password, private key, passphrase or prompt answer enters the journal.
        local::save_json(
            &directory.join("job.json"),
            &serde_json::json!({"id": id, "host": profile.host, "port": profile.port, "username": profile.username, "jumpProfileId": profile.jump_profile_id, "items": items, "options": options}),
        )?;
        let job = Arc::new(Job {
            id: id.clone(),
            session_id: session_id.clone(),
            items,
            options: options.clone(),
            profile,
            jumps,
            transport: Mutex::new(transport),
            control: Arc::new(Control::default()),
            checkpoints: Mutex::new(HashMap::new()),
            directory,
            snapshot: Mutex::new(Snapshot {
                revision: 0,
                id: id.clone(),
                session_id,
                name,
                status: "queued".into(),
                phase: "queued".into(),
                transferred: 0,
                total: 0,
                completed_files: 0,
                total_files: 0,
                failed_files: vec![],
                error: None,
                attempt: 0,
                options,
            }),
            progress: Mutex::new(HashMap::new()),
            last_emit: Mutex::new(Instant::now()),
            app: Some(app.clone()),
            channel,
            targets: self.targets.clone(),
            plan: Mutex::new(None),
            lifecycle: Mutex::new(()),
            active: AtomicBool::new(false),
            done: watch::channel(None).0,
        });
        let mut jobs = self.jobs.lock();
        if self.early_cancels.lock().remove(&id).is_some() {
            job.control.set(2);
        }
        jobs.insert(id, job.clone());
        drop(jobs);
        self.launch(job.clone());
        Ok(job)
    }
    fn launch(&self, job: Arc<Job>) {
        if job.active.swap(true, Ordering::SeqCst) {
            return;
        }
        let endpoint = endpoint_key(&job.profile);
        let limit = self
            .limits
            .lock()
            .entry(endpoint)
            .or_insert_with(|| Arc::new(Semaphore::new(2)))
            .clone();
        job.done.send_replace(None);
        tauri::async_runtime::spawn(async move {
            loop {
                let result = run_job(&job, limit.clone()).await;
                let _lifecycle = job.lifecycle.lock();
                let cancelled = matches!(&result, Err(e) if e.code == "cancelled");
                if job.control.value() != 0 && !cancelled {
                    continue;
                }
                // Publish terminal state only after the worker becomes restartable.
                // Retry immediately from an event listener must never be lost.
                job.active.store(false, Ordering::SeqCst);
                job.done
                    .send_replace(Some(result.clone().map_err(|e| e.message)));
                match result {
                    Ok(()) => {
                        job.transport.lock().take();
                        job.phase("complete");
                        job.status("complete", None);
                    }
                    Err(e) if cancelled => {
                        let cleanup_error = job.snapshot.lock().error.clone();
                        if cleanup_error.is_none() {
                            job.transport.lock().take();
                        }
                        job.status("cancelled", cleanup_error);
                        let _ = e;
                    }
                    Err(e) => job.status("error", Some(e)),
                }
                break;
            }
        });
    }
    pub fn control(&self, id: &str, action: &str) -> Result<()> {
        let job = self
            .jobs
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("transfer no longer exists"))?;
        let _lifecycle = job.lifecycle.lock();
        match action {
            "pause" if job.active.load(Ordering::SeqCst) && job.control.value() != 2 => {
                job.control.set(1);
                job.status("pausing", None);
            }
            "cancel" => {
                let snapshot = job.snapshot.lock();
                if snapshot.status == "complete"
                    || (snapshot.status == "cancelled" && snapshot.error.is_none())
                {
                    return Ok(());
                }
                drop(snapshot);
                job.control.set(2);
                job.status("cancelling", None);
                if !job.active.load(Ordering::SeqCst) {
                    self.launch(job.clone());
                }
            }
            "resume" | "retry" => {
                let status = job.snapshot.lock().status.clone();
                if matches!(status.as_str(), "complete" | "cancelled" | "cancelling") {
                    return Err(AppError::new("this transfer cannot be resumed"));
                }
                if !matches!(status.as_str(), "paused" | "error") {
                    return Err(AppError::new(
                        "wait until this transfer stops before resuming",
                    ));
                }
                // A user may have reconnected the tab (including MFA) while
                // the job was paused or failed. Reuse that authenticated transport.
                if let Some(app) = &job.app {
                    if let Some(transport) =
                        app.state::<AppState>().ssh_transports.get(&job.session_id)
                    {
                        *job.transport.lock() = Some(transport);
                    }
                }
                job.control.set(0);
                self.launch(job.clone());
            }
            "dismiss" if !job.active.load(Ordering::SeqCst) => {
                let status = job.snapshot.lock().status.clone();
                if !matches!(status.as_str(), "complete" | "cancelled") {
                    return Err(AppError::new(
                        "cancel or finish the transfer before removing it",
                    ));
                }
                if job.snapshot.lock().error.is_some() {
                    return Err(AppError::new(
                        "clean up the partial files before removing this transfer",
                    ));
                }
                for key in job.checkpoints.lock().keys() {
                    let _ = std::fs::remove_file(job.directory.join(format!("{key}.json")));
                    let _ = std::fs::remove_file(job.directory.join(format!("{key}.json.new")));
                }
                let _ = std::fs::remove_file(job.directory.join("job.json"));
                let _ = std::fs::remove_dir(&job.directory);
                self.jobs.lock().remove(id);
                self.targets
                    .lock()
                    .retain(|_, lock| Arc::strong_count(lock) > 1);
                if let Some(app) = &job.app {
                    let _ = app.emit("transfer:removed", id);
                }
            }
            _ => return Err(AppError::new("invalid transfer action")),
        }
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        let jobs = self.jobs.lock();
        if jobs.contains_key(id) {
            drop(jobs);
            let _ = self.control(id, "cancel");
            return;
        }
        let mut early = self.early_cancels.lock();
        early.retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if early.len() < 128 {
            early.insert(id.into(), Instant::now());
        }
    }
}

fn target_key(profile: &SessionProfile, item: &Item) -> String {
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

fn endpoint_key(profile: &SessionProfile) -> String {
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

pub async fn wait(job: &Job) -> Result<()> {
    let mut done = job.done.subscribe();
    loop {
        if let Some(result) = done.borrow_and_update().clone() {
            return result.map_err(AppError::new);
        }
        done.changed()
            .await
            .map_err(|_| AppError::new("transfer worker ended"))?;
    }
}

async fn run_job(job: &Arc<Job>, limit: Arc<Semaphore>) -> TransferResult<()> {
    let mut retry = 0;
    loop {
        if job.control.value() == 1 {
            job.status("paused", None);
            job.control.resumed().await;
        }
        if job.control.value() == 2 {
            let cleanup = if job.profile.kind == SessionKind::Ftp {
                ftp::cleanup(job.clone()).await
            } else {
                sftp::cleanup(job).await
            };
            job.snapshot.lock().error = cleanup.err();
            return Err(Failure::new("cancelled", "transfer cancelled", false));
        }
        job.status("queued", None);
        let permit = tokio::select! {
            _ = job.control.stopped() => continue,
            p = limit.clone().acquire_owned() => p.map_err(|e| Failure::local(e.to_string()))?,
        };
        {
            let mut snapshot = job.snapshot.lock();
            snapshot.attempt += 1;
            snapshot.failed_files.clear();
        }
        job.status("running", None);
        let result = if job.profile.kind == SessionKind::Ftp {
            ftp::run(job.clone()).await
        } else {
            sftp::run(job).await
        };
        drop(permit);
        if job.control.value() != 0 {
            continue;
        }
        match result {
            Ok(()) => return Ok(()),
            Err(e) if e.retryable && retry < 3 => {
                retry += 1;
                job.status("retrying", Some(e));
                tokio::select! {
                    _ = job.control.stopped() => {},
                    _ = tokio::time::sleep(Duration::from_secs(1 << retry)) => {},
                }
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
fn test_job(root: PathBuf) -> Arc<Job> {
    test_job_items(root, vec![])
}

#[cfg(test)]
fn test_job_items(root: PathBuf, items: Vec<Item>) -> Arc<Job> {
    let directory = root.join("journal");
    std::fs::create_dir_all(&directory).unwrap();
    let options = Options::default();
    Arc::new(Job {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: "test".into(),
        items,
        options: options.clone(),
        profile: serde_json::from_value(
            serde_json::json!({"name":"test", "kind":"sftp", "host":"fixture"}),
        )
        .unwrap(),
        jumps: vec![],
        transport: Mutex::new(None),
        control: Arc::new(Control::default()),
        checkpoints: Mutex::new(HashMap::new()),
        directory,
        snapshot: Mutex::new(Snapshot {
            revision: 0,
            id: "test".into(),
            session_id: "test".into(),
            name: "test".into(),
            status: "running".into(),
            phase: "transferring".into(),
            transferred: 0,
            total: 0,
            completed_files: 0,
            total_files: 0,
            failed_files: vec![],
            error: None,
            attempt: 0,
            options,
        }),
        progress: Mutex::new(HashMap::new()),
        last_emit: Mutex::new(Instant::now()),
        app: None,
        targets: Default::default(),
        plan: Mutex::new(None),
        lifecycle: Mutex::new(()),
        channel: Channel::new(|_| Ok(())),
        active: AtomicBool::new(false),
        done: watch::channel(None).0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_and_file_sessions_share_limits_and_target_locks() {
        let mut profile: SessionProfile = serde_json::from_value(serde_json::json!({"name":"test", "kind":"ssh", "host":"Example.COM", "username":"user"})).unwrap();
        let key = endpoint_key(&profile);
        profile.kind = SessionKind::Sftp;
        profile.host = Some("example.com".into());
        profile.port = Some(22);
        assert_eq!(key, endpoint_key(&profile));
        profile.kind = SessionKind::Ftp;
        assert_ne!(key, endpoint_key(&profile));
    }
    #[tokio::test]
    async fn pause_interrupts_a_pending_operation_and_can_resume() {
        let control = Arc::new(Control::default());
        let running = control.clone();
        let task = tokio::spawn(async move {
            running
                .run(std::future::pending::<TransferResult<()>>())
                .await
        });
        tokio::task::yield_now().await;
        control.set(1);
        let result = tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(result.code, "paused");
        control.set(0);
        assert_eq!(control.run(async { Ok(7) }).await.unwrap(), 7);
    }
    #[test]
    fn concurrency_has_a_fixed_upper_bound() {
        assert!(Options::default().validate().is_ok());
        assert!(Options {
            requests: 1000,
            ..Options::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            files: 0,
            ..Options::default()
        }
        .validate()
        .is_err());
    }
}
