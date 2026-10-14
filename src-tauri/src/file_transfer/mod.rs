//! Background file jobs. Credentials stay in memory; journals contain only
//! endpoint identity, paths, source fingerprints and confirmed checkpoints.
mod ftp;
mod local;
mod sftp;
mod tar;

#[cfg(test)]
#[path = "real_tests.rs"]
mod real_tests;

use std::collections::HashMap;
use std::future::Future;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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

/// A shared token bucket for one job's whole payload rate limit. Every
/// worker (SFTP request pipeline, FTP data socket, tar packer) draws from
/// the same bucket:
///
/// - Tokens are refilled from the monotonic clock on every lock, so a
///   waiter never reserves future budget. Cancelling a wait costs nothing;
///   waking up re-checks whatever the bucket actually holds.
/// - A slice is charged exactly when it starts moving — the request is
///   issued, the socket read begins, the archive write goes out — and a
///   short DATA or EOF read gives the unused part of its slice back.
/// - The burst is bounded by `capacity` (one second of budget, capped at
///   1 MiB), not by the SFTP request window: a paced job's whole pipeline
///   cannot run ahead of the bucket and then sleep it off.
/// - Under a low rate the slice shrinks to about 100 ms of budget
///   (`slice`), so a 1 KiB/s job moves in ~100-byte steps instead of
///   stalling minutes per chunk; the configured chunk stays the ceiling.
pub(crate) struct Pacer {
    /// Bytes per second.
    rate: u64,
    /// Maximum tokens the bucket ever holds: the whole burst allowance.
    capacity: u64,
    state: Mutex<Bucket>,
}

struct Bucket {
    tokens: u64,
    updated: tokio::time::Instant,
}

impl Pacer {
    pub(crate) fn new(rate_bps: u64) -> Self {
        let rate = rate_bps.max(1);
        let capacity = rate.min(1024 * 1024);
        Self {
            rate,
            capacity,
            state: Mutex::new(Bucket {
                tokens: capacity,
                updated: tokio::time::Instant::now(),
            }),
        }
    }

    /// The slice a paced loop should move at once: the smaller of the
    /// caller's ceiling and ~100 ms of budget (never zero).
    pub(crate) fn slice(&self, ceiling: usize) -> usize {
        ceiling.min((self.rate / 10).max(1) as usize)
    }

    fn refill(bucket: &mut Bucket, rate: u64, capacity: u64) {
        let now = tokio::time::Instant::now();
        if bucket.updated < now {
            let elapsed = now - bucket.updated;
            let refill = (elapsed.as_nanos() as u128 * rate as u128 / 1_000_000_000) as u64;
            bucket.tokens = bucket.tokens.saturating_add(refill).min(capacity);
            bucket.updated = now;
        }
    }

    /// Takes `bytes` tokens if the bucket holds them, atomically.
    fn try_take(&self, bytes: u64) -> bool {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        if bucket.tokens >= bytes {
            bucket.tokens -= bytes;
            true
        } else {
            false
        }
    }

    /// How long until `bytes` tokens exist, given a fresh refill.
    fn deficit(&self, bytes: u64) -> Duration {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        let missing = bytes.saturating_sub(bucket.tokens).max(1);
        Duration::from_nanos((missing as u128 * 1_000_000_000 / self.rate as u128) as u64)
    }

    /// Gives unused slice tokens back: a short DATA or EOF read did not
    /// move the bytes it asked for. Capped at capacity, which can only
    /// make the job slower, never faster than its limit.
    pub(crate) fn refund(&self, bytes: u64) {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        bucket.tokens = bucket.tokens.saturating_add(bytes).min(self.capacity);
    }

    /// The largest charge that can ever succeed at once.
    fn burst(&self) -> u64 {
        self.capacity
    }

    /// Takes exactly `bytes` tokens, waiting in burst-sized pieces so even
    /// a caller that names more than the burst allowance simply waits the
    /// full true duration instead of wedging.
    async fn take(&self, control: &Control, bytes: u64) -> TransferResult<()> {
        let mut remaining = bytes;
        while remaining > 0 {
            let piece = remaining.min(self.burst()).max(1);
            loop {
                if self.try_take(piece) {
                    break;
                }
                let wait = self.deficit(piece);
                tokio::select! {
                    biased;
                    _ = control.stopped() => { control.check()?; }
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            remaining -= piece;
        }
        Ok(())
    }

    /// The blocking twin of [`Pacer::take`].
    fn take_blocking(&self, control: &Control, bytes: u64) -> TransferResult<()> {
        let mut remaining = bytes;
        while remaining > 0 {
            let piece = remaining.min(self.burst()).max(1);
            loop {
                if self.try_take(piece) {
                    break;
                }
                control.check()?;
                std::thread::sleep(self.deficit(piece).min(Duration::from_millis(50)));
            }
            remaining -= piece;
        }
        Ok(())
    }
}

/// Charge `bytes` against the job's budget and wait for the bucket to hold
/// them, re-checking after every wake-up — no future budget is reserved,
/// so an interrupted wait leaves nothing behind. Returns only once the
/// tokens are taken (the caller's slice is about to move) or the job has
/// been paused/cancelled.
pub(crate) async fn paced(pacer: &Pacer, control: &Control, bytes: u64) -> TransferResult<()> {
    pacer.take(control, bytes).await
}

/// The blocking twin of [`paced`], for the FTP workers: the same
/// re-check-after-wake loop, polling the control flag while it sleeps so
/// pause and cancel stay prompt.
pub(crate) fn paced_blocking(pacer: &Pacer, control: &Control, bytes: u64) -> TransferResult<()> {
    pacer.take_blocking(control, bytes)
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
    /// The whole-job rate budget; `None` whenever `options.rate_limit_bps` is
    /// zero, so the unlimited path pays no locking at all.
    pub pacer: Option<Arc<Pacer>>,
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
    /// Charge `bytes` against this job's rate limit and wait for the
    /// bucket to hold them, immediately before the slice moves. No limit
    /// configured: returns at once. Interrupted waits take nothing.
    #[cfg(test)]
    pub async fn pace(&self, bytes: u64) -> TransferResult<()> {
        match &self.pacer {
            Some(pacer) => paced(pacer, &self.control, bytes).await,
            None => Ok(()),
        }
    }

    /// `pace` for the blocking FTP workers; see `paced_blocking`.
    pub fn pace_blocking(&self, bytes: u64) -> TransferResult<()> {
        match &self.pacer {
            Some(pacer) => paced_blocking(pacer, &self.control, bytes),
            None => Ok(()),
        }
    }

    /// How large a slice a paced loop should move at once (the rate's
    /// ~100 ms budget under the caller's ceiling); the ceiling itself
    /// when unlimited.
    pub fn pace_slice(&self, ceiling: usize) -> usize {
        match &self.pacer {
            Some(pacer) => pacer.slice(ceiling),
            None => ceiling,
        }
    }

    /// Gives a slice's unused tokens back: a short DATA or EOF read moved
    /// fewer bytes than it asked for.
    pub fn pace_refund(&self, bytes: u64) {
        if let Some(pacer) = &self.pacer {
            pacer.refund(bytes);
        }
    }

    /// Seeds counters only after the protocol has collected every planned
    /// size. Unstarted downloads must contribute their size too, otherwise
    /// a completed checkpoint can appear to be 100% of an unfinished tree.
    pub fn prime_resumed_progress(&self, plan: &[Item], sizes: &[u64]) {
        assert_eq!(plan.len(), sizes.len());
        for (item, &size) in plan.iter().zip(sizes) {
            let key = self.key(item);
            if let Some(cp) = self.checkpoint(&key) {
                self.progress(&key, cp.offset, cp.source.size, cp.complete);
            } else {
                self.progress(&key, 0, size, false);
            }
        }
    }

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
        checkpoint_key(&self.id, item)
    }
    pub fn checkpoint(&self, key: &str) -> Option<Checkpoint> {
        self.checkpoints.lock().get(key).cloned()
    }

    /// Persists the exact expanded item list a run will transfer, after
    /// planning and local-path normalization and before the first byte
    /// moves. Restart recovery rebuilds the job from this frozen list, so
    /// files added or removed later never silently change what a resumed
    /// job claims to have done.
    pub fn save_plan(&self, items: &[Item]) -> TransferResult<()> {
        local::save_json(
            &self.directory.join("plan.json"),
            &serde_json::json!({ "items": items }),
        )
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
    /// `save` for async code: the write, its fsync and the write-through
    /// rename are blocking disk calls, so they run on the blocking pool
    /// instead of holding a runtime thread. The in-memory checkpoint is
    /// updated only after the file is on disk, as in `save`.
    pub async fn save_async(&self, checkpoint: &Checkpoint) -> TransferResult<()> {
        let path = self.directory.join(format!("{}.json", checkpoint.key));
        let snapshot = checkpoint.clone();
        let written = snapshot.clone();
        tokio::task::spawn_blocking(move || local::save_json(&path, &written))
            .await
            .map_err(|e| Failure::local(e.to_string()))??;
        self.checkpoints
            .lock()
            .insert(snapshot.key.clone(), snapshot);
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
    /// Per-endpoint job slots: at most two jobs per endpoint run at once;
    /// the rest wait in the queue (and stay pausable/cancellable there).
    /// This is job-level concurrency — the per-job `files`/`requests`
    /// options are separate and live inside one running job.
    limits: Mutex<HashMap<String, Arc<Semaphore>>>,
    targets: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    early_cancels: Mutex<HashMap<String, Instant>>,
    /// Journal root override. Production reads `transfers_root()`; tests
    /// inject a temporary directory so no test ever scans, writes or
    /// deletes a real user's journals.
    root: Option<PathBuf>,
    #[cfg(test)]
    test_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}
impl Transfers {
    /// A manager whose journals live under `root` instead of the user's
    /// data directory. Test isolation only: recovery, discovery and discard
    /// then operate exclusively inside that sandbox.
    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root: Some(root),
            ..Self::default()
        }
    }
    fn root(&self) -> PathBuf {
        self.root.clone().unwrap_or_else(transfers_root)
    }
    /// End paused test runs without cancellation cleanup, as a process exit
    /// would. Call only after their I/O workers have reached the paused state.
    #[cfg(test)]
    async fn stop_test_workers(&self) {
        let tasks = std::mem::take(&mut *self.test_tasks.lock());
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
    }
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
        app: Option<AppHandle>,
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
        // Journals and events need no window; tests drive the engine without
        // one, and the recovery path hands the rebuilt job the same Option.
        let (jumps, transport) = match &app {
            Some(app) => {
                let state = app.state::<AppState>();
                (
                    state.store.jump_chain(&profile)?,
                    state.ssh_transports.get(&session_id),
                )
            }
            None => (Vec::new(), None),
        };
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if !valid_journal_id(&id) {
            return Err(AppError::new("invalid transfer id"));
        }
        let root = self.root();
        let directory = root.join(&id);
        std::fs::create_dir_all(&root)?;
        std::fs::create_dir(&directory)?;
        let name = job_name(&items);
        // No password, private key, passphrase or prompt answer enters the
        // journal. `version`/`kind`/`endpoint` are what restart recovery
        // matches a live session against; without them a journal cannot be
        // attributed safely and recovery refuses it.
        local::save_json(
            &directory.join("job.json"),
            &journal_json(&id, &profile, &items, &options),
        )?;
        let job = self.rebuild(
            id.clone(),
            session_id,
            items,
            None,
            options,
            profile,
            jumps,
            transport,
            directory,
            name,
            HashMap::new(),
            channel,
            app,
        )?;
        let mut jobs = self.jobs.lock();
        if self.early_cancels.lock().remove(&id).is_some() {
            job.control.set(2);
        }
        jobs.insert(id, job.clone());
        drop(jobs);
        self.launch(job.clone());
        Ok(job)
    }
    /// The one constructor a fresh start and a restart recovery share: every
    /// field of a `Job`, from the journal's own values. `frozen_plan` is
    /// the journal's saved plan, preloaded into the job's plan cache so a
    /// resumed job transfers exactly what the interrupted run planned —
    /// not whatever the filesystem looks like now.
    #[allow(clippy::too_many_arguments)]
    fn rebuild(
        &self,
        id: String,
        session_id: String,
        items: Vec<Item>,
        frozen_plan: Option<Vec<Item>>,
        options: Options,
        profile: SessionProfile,
        jumps: Vec<SessionProfile>,
        transport: Option<Arc<SharedTransport>>,
        directory: PathBuf,
        name: String,
        checkpoints: HashMap<String, Checkpoint>,
        channel: Channel<TransferProgress>,
        app: Option<AppHandle>,
    ) -> Result<Arc<Job>> {
        let pacer =
            (options.rate_limit_bps > 0).then(|| Arc::new(Pacer::new(options.rate_limit_bps)));
        Ok(Arc::new(Job {
            id: id.clone(),
            session_id: session_id.clone(),
            items,
            options: options.clone(),
            profile,
            jumps,
            transport: Mutex::new(transport),
            control: Arc::new(Control::default()),
            pacer,
            checkpoints: Mutex::new(checkpoints),
            directory,
            snapshot: Mutex::new(Snapshot {
                revision: 0,
                id,
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
            app,
            channel,
            targets: self.targets.clone(),
            plan: Mutex::new(frozen_plan),
            lifecycle: Mutex::new(()),
            active: AtomicBool::new(false),
            done: watch::channel(None).0,
        }))
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
        let task = tauri::async_runtime::spawn(async move {
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
        #[cfg(test)]
        self.test_tasks.lock().push(task);
        #[cfg(not(test))]
        drop(task);
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

    /// The profile `session_id` last connected with, while that session is
    /// still open; recovery matches a journal against exactly this.
    pub fn profile_of(&self, session_id: &str) -> Option<SessionProfile> {
        self.profiles.lock().get(session_id).cloned()
    }

    /// One interrupted job found on disk after a restart, or one whose
    /// journal cannot be attributed safely (kept, never adopted).
    pub fn discover(&self) -> Vec<Recoverable> {
        let root = self.root();
        let mut found: Vec<Recoverable> = match std::fs::read_dir(&root) {
            Ok(entries) => entries
                .flatten()
                .filter_map(|entry| {
                    let id: String = entry.file_name().to_string_lossy().into();
                    if !valid_journal_id(&id) || self.jobs.lock().contains_key(id.as_str()) {
                        return None; // foreign name, or live in this run already
                    }
                    recoverable_from(&root.join(&id), &id)
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        found.sort_by(|a, b| a.id.cmp(&b.id));
        found
    }

    /// Reads back a journal written by this version, refusing anything it
    /// cannot attribute or verify (older layouts, tampered keys). Refusal
    /// leaves every file on disk untouched.
    pub fn read_persisted(&self, id: &str) -> Result<PersistedJournal> {
        if !valid_journal_id(id) {
            return Err(AppError::new("invalid transfer id"));
        }
        if self.jobs.lock().contains_key(id) {
            return Err(AppError::new("this transfer is already active"));
        }
        let directory = self.root().join(id);
        require_journal_directory(&directory)?;
        let text = std::fs::read_to_string(directory.join("job.json"))
            .map_err(|e| AppError::new(format!("cannot read the transfer journal: {e}")))?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::new(format!("damaged transfer journal: {e}")))?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(JOURNAL_VERSION) {
            return Err(AppError::new(
                "this journal predates restart recovery; start the transfer again",
            ));
        }
        if value.get("id").and_then(|v| v.as_str()) != Some(id) {
            return Err(AppError::new(
                "transfer journal id does not match its directory",
            ));
        }
        let kind = value
            .get("kind")
            .and_then(|v| v.as_str())
            .filter(|v| v == &"sftp" || v == &"ftp")
            .ok_or_else(|| AppError::new("damaged transfer journal: no protocol"))?
            .to_string();
        let endpoint = value
            .get("endpoint")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| AppError::new("damaged transfer journal: no endpoint"))?
            .to_string();
        // Human-readable identity for the recovery UI; the endpoint key
        // above stays the machine's only matching truth.
        let host = value
            .get("host")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let port = value
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|v| u16::try_from(v).ok());
        let username = value
            .get("username")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let items: Vec<Item> = serde_json::from_value(
            value
                .get("items")
                .cloned()
                .ok_or_else(|| AppError::new("damaged transfer journal: no items"))?,
        )
        .map_err(|e| AppError::new(format!("damaged transfer journal items: {e}")))?;
        if items.is_empty() {
            return Err(AppError::new("damaged transfer journal: no items"));
        }
        let options: Options = value
            .get("options")
            .cloned()
            .and_then(|o| serde_json::from_value(o).ok())
            .ok_or_else(|| AppError::new("damaged transfer journal options"))?;
        options.validate()?;
        // The frozen plan, exactly as the interrupted run expanded and
        // normalized it. Recovery rebuilds from this list, so later
        // filesystem changes cannot silently alter what the job transfers.
        // Every planned row must itself sit under one of the journal's
        // top-level rows — same direction, same relative path on both
        // sides, no `..` tricks — before anything is claimed. No plan at
        // all means the job was interrupted before planning: its recovery
        // re-plans from the top-level rows instead.
        let plan: Option<Vec<Item>> = match std::fs::read_to_string(directory.join("plan.json")) {
            Ok(text) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| AppError::new(format!("damaged transfer plan: {e}")))?;
                let planned: Vec<Item> = serde_json::from_value(
                    parsed
                        .get("items")
                        .cloned()
                        .ok_or_else(|| AppError::new("damaged transfer plan: no items"))?,
                )
                .map_err(|e| AppError::new(format!("damaged transfer plan items: {e}")))?;
                if planned
                    .iter()
                    .any(|item| item.directory || !checkpoint_belongs(item, &items))
                {
                    return Err(AppError::new(
                        "the saved plan does not sit under this journal's items; nothing was claimed",
                    ));
                }
                Some(planned)
            }
            // A job interrupted before planning wrote no plan and no
            // checkpoints; recovery starts it over. A checkpoint without a
            // plan cannot happen through the engine (the plan is saved
            // before the first byte moves) and is refused below.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(AppError::new(format!(
                    "cannot read the transfer plan: {error}"
                )))
            }
        };
        // Every checkpoint must parse, sit under its own 24-hex name,
        // re-derive its key from its own item, be an exact row of the
        // frozen plan (local, remote and direction — not merely a path
        // shape), and name the exact partial/backup paths the engine
        // derives. Anything else — a planted file, a saved path redirected
        // elsewhere — is not ours to claim.
        let mut checkpoints = HashMap::new();
        let entries = std::fs::read_dir(&directory)
            .map_err(|e| AppError::new(format!("cannot read the transfer journal: {e}")))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            if stem == "job" || stem.len() != 24 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
                continue;
            }
            let cp: Checkpoint = serde_json::from_str(
                &std::fs::read_to_string(entry.path())
                    .map_err(|e| AppError::new(format!("cannot read checkpoint {stem}: {e}")))?,
            )
            .map_err(|e| AppError::new(format!("damaged checkpoint {stem}: {e}")))?;
            if cp.key != stem {
                return Err(AppError::new(format!(
                    "checkpoint {stem} does not match its own name; nothing was claimed"
                )));
            }
            if checkpoint_key(id, &cp.item) != cp.key {
                return Err(AppError::new(format!(
                    "checkpoint {stem} does not derive from its own item; nothing was claimed"
                )));
            }
            let Some(plan) = &plan else {
                return Err(AppError::new(
                    "checkpoints exist without a saved plan; nothing was claimed",
                ));
            };
            if !plan.iter().any(|row| row == &cp.item) {
                return Err(AppError::new(format!(
                    "checkpoint {stem} ({} → {}) is not a row of this journal's saved plan; nothing was claimed",
                    cp.item.local, cp.item.remote
                )));
            }
            if !checkpoint_paths_are_derived(&cp) {
                return Err(AppError::new(format!(
                    "checkpoint {stem} names partial paths the engine would not derive \
                     ({} / {}); nothing was claimed",
                    cp.temporary, cp.backup
                )));
            }
            checkpoints.insert(cp.key.clone(), cp);
        }
        Ok(PersistedJournal {
            id: id.to_string(),
            kind,
            endpoint,
            host,
            port,
            username,
            items,
            plan,
            options,
            checkpoints,
        })
    }

    /// Rebuilds a journaled job to run under `session_id`'s live profile.
    /// The caller (IPC layer) has already matched the endpoint; it is
    /// re-checked here so no other path can adopt a foreign journal.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt(
        &self,
        app: Option<AppHandle>,
        journal: PersistedJournal,
        session_id: String,
        profile: SessionProfile,
        jumps: Vec<SessionProfile>,
        transport: Option<Arc<SharedTransport>>,
        channel: Channel<TransferProgress>,
    ) -> Result<Arc<Job>> {
        let kind = journal_kind(&profile);
        if kind != journal.kind || endpoint_key(&profile) != journal.endpoint {
            return Err(AppError::new(
                "this session does not match the interrupted transfer's endpoint",
            ));
        }
        let name = job_name(&journal.items);
        let directory = self.root().join(&journal.id);
        // Only a journal that actually froze a plan runs it as written; one
        // interrupted before planning re-plans from its top-level rows, so
        // a folder row is never mistaken for a plan of files.
        let frozen = journal.plan.clone();
        let job = self.rebuild(
            journal.id.clone(),
            session_id,
            journal.items,
            frozen,
            journal.options,
            profile,
            jumps,
            transport,
            directory,
            name,
            journal.checkpoints,
            channel,
            app,
        )?;
        let mut jobs = self.jobs.lock();
        if jobs.contains_key(&job.id) {
            return Err(AppError::new("this transfer is already active"));
        }
        if self.early_cancels.lock().remove(&job.id).is_some() {
            job.control.set(2);
        }
        jobs.insert(job.id.clone(), job.clone());
        drop(jobs);
        self.launch(job.clone());
        Ok(job)
    }

    /// Deletes an interrupted job's journal directory. Live jobs must go
    /// through `control`'s dismiss, which cleans up owned partials first.
    ///
    /// The id is validated here, not in the UI: an empty id names the root
    /// itself and `..`/absolute paths escape it, so anything but the
    /// journal id alphabet is refused before a path is built. A symlink
    /// where a journal directory should be is refused too — the delete
    /// must never follow a link out of the journal root.
    pub fn discard_persisted(&self, id: &str) -> Result<()> {
        if !valid_journal_id(id) {
            return Err(AppError::new("invalid transfer id"));
        }
        if self.jobs.lock().contains_key(id) {
            return Err(AppError::new(
                "this transfer is active; dismiss it from the transfer list instead",
            ));
        }
        let directory = self.root().join(id);
        require_journal_directory(&directory)?;
        std::fs::remove_dir_all(&directory)
            .map_err(|e| AppError::new(format!("cannot remove the journal: {e}")))
    }
}

/// The only ids a journal directory may carry: 1–100 characters of ASCII
/// alphanumerics and `-`. This excludes path separators, `..`, and every
/// form of absolute or nested path, before any of them reach `join`.
fn valid_journal_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn require_journal_directory(path: &Path) -> Result<()> {
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
fn checkpoint_belongs(item: &Item, items: &[Item]) -> bool {
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
fn same_local(a: &str, b: &str) -> bool {
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
fn local_components(path: &str) -> Option<Vec<String>> {
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
fn local_child(child: &str, parent: &str) -> Option<Vec<String>> {
    let child = local_components(child)?;
    let parent = local_components(parent)?;
    if child.len() < parent.len() || child[..parent.len()] != parent[..] {
        return None;
    }
    Some(child[parent.len()..].to_vec())
}

/// `local_child` for remote paths, which are always POSIX: split on `/`,
/// normalize repeated separators but refuse `.`/`..` and mismatched roots.
fn posix_child(child: &str, parent: &str) -> Option<Vec<String>> {
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
fn checkpoint_paths_are_derived(cp: &Checkpoint) -> bool {
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
fn transfers_root() -> PathBuf {
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
const JOURNAL_VERSION: u64 = 2;

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
fn journal_kind(profile: &SessionProfile) -> &'static str {
    if profile.kind == SessionKind::Ftp {
        "ftp"
    } else {
        "sftp"
    }
}

fn job_name(items: &[Item]) -> String {
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

fn recoverable_from(directory: &Path, id: &str) -> Option<Recoverable> {
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

/// The checkpoint-file name (and journal key) of one item under one job:
/// derived from the job id and the exact paths and direction, so a journal
/// can tell its own checkpoints from anything planted beside them.
fn checkpoint_key(job_id: &str, item: &Item) -> String {
    local::digest(
        format!(
            "{}\0{}\0{}\0{}",
            job_id, item.local, item.remote, item.upload
        )
        .as_bytes(),
    )[..24]
        .into()
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

/// The endpoint identity a live session and a journal are matched on.
pub(crate) fn endpoint_of(profile: &SessionProfile) -> String {
    endpoint_key(profile)
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
            // A tar-streaming job records no per-file checkpoints, so there is
            // nothing remote to remove beyond what the remote tar had already
            // written when the channel was closed: no partials, no backups,
            // and no ownership to claim. The SFTP cleanup walks the journal
            // and finds nothing for such a job.
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
        } else if tar::wants_tar(job) {
            tar::run(job).await
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
        pacer: None,
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
        assert!(Options {
            files: 33,
            ..Options::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            files: 32,
            ..Options::default()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn rate_limit_options_reject_out_of_range_and_default_to_unlimited() {
        assert!(Options::default().validate().is_ok());
        assert_eq!(Options::default().rate_limit_bps, 0);
        assert!(Options {
            rate_limit_bps: 1024,
            ..Options::default()
        }
        .validate()
        .is_ok());
        assert!(Options {
            rate_limit_bps: 1 << 30,
            ..Options::default()
        }
        .validate()
        .is_ok());
        for bad in [1u64, 1023, (1 << 30) + 1, u64::MAX] {
            assert!(Options {
                rate_limit_bps: bad,
                ..Options::default()
            }
            .validate()
            .is_err());
        }
        // A saved preference without the field keeps its concurrency and
        // picks up unlimited, rather than being rejected whole.
        let parsed: Options = serde_json::from_str(
            r#"{"requests":8,"chunkKib":64,"files":4,"durable":false,"tar":false}"#,
        )
        .unwrap();
        assert_eq!(parsed.rate_limit_bps, 0);
        assert!(parsed.validate().is_ok());
    }

    #[test]
    fn pacer_bucket_charges_refunds_and_bounds_slices() {
        let pacer = Pacer::new(8192);
        // The bucket starts full: the whole burst (one second of budget)
        // is available, and taking from it is immediate.
        assert!(pacer.try_take(8192));
        // The next 8 KiB need a full second of refill.
        assert!(pacer.deficit(8192) >= Duration::from_millis(990));
        // A refund gives unused tokens back, capped at the burst size.
        pacer.refund(4096);
        assert!(pacer.try_take(4096));
        assert!(pacer.deficit(8192) >= Duration::from_millis(490));
        // Slices shrink to ~100 ms of budget under the caller's ceiling.
        assert_eq!(pacer.slice(128 * 1024), 819);
        assert_eq!(pacer.slice(500), 500);
        let fast = Pacer::new(64 * 1024 * 1024);
        assert_eq!(fast.slice(128 * 1024), 128 * 1024);
        // Zero rate never happens (construction clamps), but zero bytes
        // are free.
        assert!(pacer.try_take(0));
        // The burst allowance is capped at 1 MiB even for fast rates.
        assert_eq!(fast.burst(), 1024 * 1024);
        assert_eq!(pacer.burst(), 8192);
    }

    #[tokio::test]
    async fn pace_wait_is_interrupted_by_pause_and_cancel() {
        // 2 KiB at 1 KiB/s with a 1 KiB burst: the first kilobyte runs at
        // once, the second has to wait a full second — a real wait the stop
        // signal must interrupt. The future is spawned and given time to
        // enter that wait first; a future that was never polled would prove
        // nothing, and an early return would fail the unwrap_err below.
        async fn interrupted(stop: u8, code: &str) {
            let pacer = Arc::new(Pacer::new(1024));
            let control = Arc::new(Control::default());
            let waiting = {
                let pacer = pacer.clone();
                let control = control.clone();
                tokio::spawn(async move { paced(&pacer, &control, 2048).await })
            };
            tokio::time::sleep(Duration::from_millis(100)).await;
            control.set(stop);
            let error = tokio::time::timeout(Duration::from_millis(250), waiting)
                .await
                .expect("the stop signal interrupts an ongoing pace wait")
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, code);
        }
        interrupted(1, "paused").await;
        interrupted(2, "cancelled").await;
        // No pacer configured: the unlimited path returns immediately.
        let unlimited = test_job_items(scratch(), Vec::new());
        tokio::time::timeout(Duration::from_millis(50), unlimited.pace(1024 * 1024))
            .await
            .expect("unlimited jobs never wait")
            .unwrap();
    }

    #[test]
    fn paced_blocking_is_interrupted_by_cancel() {
        let pacer = Arc::new(Pacer::new(1024));
        let control = Arc::new(Control::default());
        // 2 KiB against a 1 KiB burst: the thread takes its burst at once
        // and then genuinely waits for the second.
        let waiter = {
            let pacer = pacer.clone();
            let control = control.clone();
            std::thread::spawn(move || paced_blocking(&pacer, &control, 2048))
        };
        std::thread::sleep(Duration::from_millis(100));
        control.set(2);
        let error = waiter.join().unwrap().unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn journal_ids_reject_every_path_shape() {
        assert!(valid_journal_id("a"));
        assert!(valid_journal_id("0123456789abcdef0123456789abcdef"));
        assert!(valid_journal_id(&"x".repeat(100)));
        for bad in [
            "",
            ".",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "/abs",
            "C:\\x",
            "a b",
            "a:b",
            &"x".repeat(101),
        ] {
            assert!(!valid_journal_id(bad), "{bad:?} must not be a journal id");
        }
    }

    #[test]
    fn checkpoint_attribution_covers_planned_children_not_foreign_paths() {
        let folder = Item {
            local: "/src/dir".into(),
            remote: "/dst/dir".into(),
            upload: true,
            directory: true,
        };
        let file = Item {
            local: "/src/dir/a".into(),
            remote: "/dst/dir/a".into(),
            upload: true,
            directory: false,
        };
        // A planned child of the folder row, with the same relative path on
        // both sides — and a Windows-style local path is a child too.
        assert!(checkpoint_belongs(&file, &[folder.clone()]));
        let windows = Item {
            local: "G:\\src\\dir\\a".into(),
            remote: "/dst/dir/a".into(),
            upload: true,
            directory: false,
        };
        let windows_folder = Item {
            local: "G:\\src\\dir".into(),
            remote: "/dst/dir".into(),
            upload: true,
            directory: true,
        };
        assert!(checkpoint_belongs(&windows, &[windows_folder.clone()]));
        #[cfg(windows)]
        assert!(!checkpoint_belongs(
            &Item {
                local: "H:\\src\\dir\\a".into(),
                ..windows.clone()
            },
            &[windows_folder.clone()]
        ));
        let slash_file = Item {
            remote: "//dst//dir/a".into(),
            ..file.clone()
        };
        assert!(checkpoint_belongs(&file, &[slash_file]));
        assert!(!checkpoint_belongs(
            &Item {
                remote: "dst/dir/a".into(),
                ..file.clone()
            },
            &[file.clone()]
        ));
        // The folder row itself carries no checkpoint.
        let as_file = Item {
            local: "/src/dir".into(),
            remote: "/dst/dir".into(),
            upload: true,
            directory: false,
        };
        assert!(!checkpoint_belongs(&as_file, &[folder.clone()]));
        // A same-prefix sibling directory is not the folder.
        let sibling = Item {
            local: "/src/dir/other/x".into(),
            remote: "/dst/directory/x".into(),
            upload: true,
            directory: false,
        };
        let prefix_folder = Item {
            local: "/src/dir".into(),
            remote: "/dst/dir".into(),
            upload: true,
            directory: true,
        };
        assert!(!checkpoint_belongs(&sibling, &[prefix_folder]));
        // `..` never escapes the folder on either side.
        let escape_remote = Item {
            local: "/src/dir/a".into(),
            remote: "/dst/dir/../outside".into(),
            upload: true,
            directory: false,
        };
        assert!(!checkpoint_belongs(&escape_remote, &[folder.clone()]));
        let escape_local = Item {
            local: "/src/dir/../outside".into(),
            remote: "/dst/dir/a".into(),
            upload: true,
            directory: false,
        };
        assert!(!checkpoint_belongs(&escape_local, &[folder.clone()]));
        // A child whose relative paths differ between the sides is not a
        // planned child.
        let mismatched = Item {
            local: "/src/dir/x".into(),
            remote: "/dst/dir/y".into(),
            upload: true,
            directory: false,
        };
        assert!(!checkpoint_belongs(&mismatched, &[folder.clone()]));
        // Outside the folder, or the other direction: no.
        let outside = Item {
            local: "/etc/passwd".into(),
            remote: "/dst/dir/evil".into(),
            upload: true,
            directory: false,
        };
        assert!(!checkpoint_belongs(&outside, &[folder.clone()]));
        let download = Item {
            local: "/src/dir/a".into(),
            remote: "/dst/dir/a".into(),
            upload: false,
            directory: false,
        };
        assert!(!checkpoint_belongs(&download, &[folder]));
        // A file row matches only the exact remote — never a "child" of it.
        assert!(checkpoint_belongs(&file, &[file.clone()]));
        // The derived upload partial/backup paths — and nothing else.
        let key = "0123456789abcdef01234567";
        let cp = |temporary: String, backup: String| Checkpoint {
            key: key.into(),
            item: file.clone(),
            source: Signature {
                size: 0,
                modified: None,
                sample: local::digest(&[]),
            },
            original: None,
            temporary,
            backup,
            offset: 0,
            prefix_hash: local::digest(&[]),
            complete: false,
            committing: false,
            owns_temporary: true,
            owns_backup: false,
        };
        assert!(checkpoint_paths_are_derived(&cp(
            "/dst/dir/.edgeterm-0123456789abcdef01234567.part".into(),
            "/dst/dir/.edgeterm-0123456789abcdef01234567.backup".into(),
        )));
        assert!(!checkpoint_paths_are_derived(&cp(
            "/etc/passwd".into(),
            "/dst/dir/.edgeterm-0123456789abcdef01234567.backup".into(),
        )));
        assert!(!checkpoint_paths_are_derived(&cp(
            "/dst/.edgeterm-0123456789abcdef01234567.part".into(),
            "/dst/.other.backup".into(),
        )));
    }

    /// A v2 journal on disk, the shape `start` writes, for recovery tests.
    fn write_journal(root: &Path, id: &str, items: &[Item], rate_limit_bps: u64) {
        let directory = root.join(id);
        std::fs::create_dir_all(&directory).unwrap();
        local::save_json(
            &directory.join("job.json"),
            &serde_json::json!({
                "version": JOURNAL_VERSION,
                "id": id,
                "kind": "sftp",
                "endpoint": endpoint_key(&sftp_profile()),
                "host": "example.com",
                "port": 22,
                "username": "user",
                "jumpProfileId": null,
                "items": items,
                "options": {
                    "requests": 8, "chunkKib": 64, "files": 4,
                    "durable": false, "tar": false, "rateLimitBps": rate_limit_bps
                }
            }),
        )
        .unwrap();
    }

    fn sftp_profile() -> SessionProfile {
        serde_json::from_value(
            serde_json::json!({"name":"t", "kind":"sftp", "host":"example.com", "username":"user"}),
        )
        .unwrap()
    }

    fn sink() -> Channel<TransferProgress> {
        Channel::new(|_| Ok(()))
    }

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("edgeterm-journal-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn recovery_lists_reads_and_rebuilds_a_journal() {
        let root = scratch();
        let items = vec![Item {
            local: "/src/a".into(),
            remote: "/dst/a".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "recover-me-1", &items, 4096);
        // A real checkpoint for that item, saved through the production
        // serializer with the paths the engine derives.
        let key = checkpoint_key("recover-me-1", &items[0]);
        let cp = Checkpoint {
            key: key.clone(),
            item: items[0].clone(),
            source: Signature {
                size: 3,
                modified: None,
                sample: local::digest(b"abc"),
            },
            original: None,
            temporary: format!("/dst/.edgeterm-{key}.part"),
            backup: format!("/dst/.edgeterm-{key}.backup"),
            offset: 0,
            prefix_hash: local::digest(&[]),
            complete: false,
            committing: false,
            owns_temporary: true,
            owns_backup: false,
        };
        local::save_json(&root.join("recover-me-1").join(format!("{key}.json")), &cp).unwrap();
        // The engine freezes the expanded plan beside the journal before
        // the first byte moves; a claimable journal carries it.
        local::save_json(
            &root.join("recover-me-1").join("plan.json"),
            &serde_json::json!({ "items": items }),
        )
        .unwrap();

        let manager = Transfers::with_root(root.clone());
        let found = manager.discover();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "recover-me-1");
        assert_eq!(found[0].kind.as_deref(), Some("sftp"));
        assert_eq!(found[0].items, 1);
        assert_eq!(found[0].checkpoints, 1);
        assert!(!found[0].unrecognized);

        let journal = manager.read_persisted("recover-me-1").unwrap();
        assert_eq!(journal.checkpoints.len(), 1);
        assert!(
            journal.plan.is_some(),
            "a journal with a saved plan carries it frozen"
        );
        // The pure rebuild — no launch, no dial: the adopt-to-completion
        // proof runs against a live local fixture in the FTP tests, and
        // against the dedicated OpenSSH fixture in the ignored set.
        let adopted = manager
            .rebuild(
                journal.id.clone(),
                "session-1".into(),
                journal.items,
                None,
                journal.options,
                sftp_profile(),
                Vec::new(),
                None,
                root.join("recover-me-1"),
                "a".into(),
                journal.checkpoints,
                sink(),
                None,
            )
            .unwrap();
        // The rebuilt job carries the saved checkpoint and its own pacer.
        assert!(adopted.checkpoint(&key).is_some());
        let pacer = adopted.pacer.as_ref().expect("rate limit builds a pacer");
        let rebuilt = manager
            .rebuild(
                "recover-me-2".into(),
                "session-2".into(),
                vec![items_default()],
                None,
                Options {
                    rate_limit_bps: 4096,
                    ..Options::default()
                },
                sftp_profile(),
                Vec::new(),
                None,
                root.join("recover-me-2"),
                "a".into(),
                HashMap::new(),
                sink(),
                None,
            )
            .unwrap();
        // Two jobs never share a budget: each rebuild builds its own pacer,
        // and an unlimited job builds none at all.
        assert!(!Arc::ptr_eq(pacer, rebuilt.pacer.as_ref().unwrap()));
        assert!(
            manager
                .rebuild(
                    "recover-me-3".into(),
                    "session-3".into(),
                    vec![items_default()],
                    None,
                    Options::default(),
                    sftp_profile(),
                    Vec::new(),
                    None,
                    root.join("recover-me-3"),
                    "a".into(),
                    HashMap::new(),
                    sink(),
                    None,
                )
                .unwrap()
                .pacer
                .is_none(),
            "no limit, no pacer"
        );
        drop(adopted);
        drop(rebuilt);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn items_default() -> Item {
        Item {
            local: "/s".into(),
            remote: "/d".into(),
            upload: true,
            directory: false,
        }
    }

    #[test]
    fn recovery_refuses_foreign_checkpoints_and_keeps_files() {
        for case in ["foreign-item", "redirected-temporary"] {
            let root = scratch();
            let items = vec![Item {
                local: "/src/a".into(),
                remote: "/dst/a".into(),
                upload: true,
                directory: false,
            }];
            write_journal(&root, "recover-refuse", &items, 0);
            let key = checkpoint_key("recover-refuse", &items[0]);
            let foreign_item = Item {
                local: "/elsewhere".into(),
                remote: "/dst/a".into(),
                upload: true,
                directory: false,
            };
            let item = if case == "foreign-item" {
                foreign_item.clone()
            } else {
                items[0].clone()
            };
            let temporary = if case == "redirected-temporary" {
                "/etc/passwd".to_string()
            } else {
                format!("/dst/.edgeterm-{key}.part")
            };
            // The key still matches its own (possibly foreign) item, so the
            // refusal has to come from attribution, not the name check.
            let cp = Checkpoint {
                key: checkpoint_key("recover-refuse", &item),
                item,
                source: Signature {
                    size: 0,
                    modified: None,
                    sample: local::digest(&[]),
                },
                original: None,
                temporary,
                backup: format!("/dst/.edgeterm-{key}.backup"),
                offset: 0,
                prefix_hash: local::digest(&[]),
                complete: false,
                committing: false,
                owns_temporary: true,
                owns_backup: false,
            };
            let path = root.join("recover-refuse").join(format!("{}.json", cp.key));
            local::save_json(&path, &cp).unwrap();
            let manager = Transfers::with_root(root.clone());
            assert!(
                manager.read_persisted("recover-refuse").is_err(),
                "{case} must be refused"
            );
            // Refusal claims nothing: journal and checkpoint are still there.
            assert!(root.join("recover-refuse/job.json").exists());
            assert!(path.exists());
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn recovery_refuses_checkpoints_without_a_saved_plan() {
        let root = scratch();
        let items = vec![Item {
            local: "/src/a".into(),
            remote: "/dst/a".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "no-plan", &items, 0);
        let key = checkpoint_key("no-plan", &items[0]);
        let cp = Checkpoint {
            key: key.clone(),
            item: items[0].clone(),
            source: Signature {
                size: 3,
                modified: None,
                sample: local::digest(b"abc"),
            },
            original: None,
            temporary: format!("/dst/.edgeterm-{key}.part"),
            backup: format!("/dst/.edgeterm-{key}.backup"),
            offset: 0,
            prefix_hash: local::digest(&[]),
            complete: false,
            committing: false,
            owns_temporary: true,
            owns_backup: false,
        };
        let path = root.join("no-plan").join(format!("{key}.json"));
        local::save_json(&path, &cp).unwrap();
        let manager = Transfers::with_root(root.clone());
        // A checkpoint with no frozen plan cannot show what the
        // interrupted run actually transferred: refuse, claim nothing.
        assert!(manager.read_persisted("no-plan").is_err());
        assert!(root.join("no-plan/job.json").exists());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn adopt_without_a_saved_plan_replans_instead_of_running_top_level_rows() {
        let root = scratch();
        let items = vec![Item {
            local: "/src".into(),
            remote: "/dst".into(),
            upload: true,
            directory: true,
        }];
        // Interrupted before planning: a journal with no plan.json and no
        // checkpoints. Its top-level folder row must never run as though
        // it were a plan of files — recovery re-plans from the items.
        write_journal(&root, "no-plan-replan", &items, 0);
        let manager = Transfers::with_root(root.clone());
        let journal = manager.read_persisted("no-plan-replan").unwrap();
        assert!(journal.plan.is_none(), "no plan.json means no frozen plan");
        // Exercise adopt's constructor without dialing a public host.
        manager.cancel("no-plan-replan");
        let job = manager
            .adopt(
                None,
                journal,
                "s".into(),
                sftp_profile(),
                Vec::new(),
                None,
                sink(),
            )
            .unwrap();
        assert!(
            job.plan.lock().is_none(),
            "the rebuilt job must re-plan, not run folder rows as a plan"
        );
        manager.stop_test_workers().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recovery_accepts_empty_frozen_plans_and_refuses_plan_io_errors() {
        let root = scratch();
        let items = vec![Item {
            local: "/empty".into(),
            remote: "/empty".into(),
            upload: true,
            directory: true,
        }];
        write_journal(&root, "empty-plan", &items, 0);
        let plan = root.join("empty-plan/plan.json");
        local::save_json(&plan, &serde_json::json!({"items":[]})).unwrap();
        let manager = Transfers::with_root(root.clone());
        assert_eq!(
            manager.read_persisted("empty-plan").unwrap().plan,
            Some(vec![])
        );
        std::fs::remove_file(&plan).unwrap();
        std::fs::create_dir(&plan).unwrap();
        assert!(manager
            .read_persisted("empty-plan")
            .err()
            .unwrap()
            .to_string()
            .contains("cannot read the transfer plan"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_refuses_a_journal_copied_under_another_id() {
        let root = scratch();
        write_journal(&root, "original", &[items_default()], 0);
        std::fs::rename(root.join("original"), root.join("copied")).unwrap();
        let manager = Transfers::with_root(root.clone());
        assert!(manager.read_persisted("copied").is_err());
        assert!(root.join("copied/job.json").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_refuses_unrecognized_journals_and_corrupt_files() {
        let root = scratch();
        // No version marker: listed as unrecognized, never adopted.
        let legacy = root.join("legacy-dir");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("job.json"), r#"{"id":"legacy-dir","items":[]}"#).unwrap();
        let manager = Transfers::with_root(root.clone());
        let found = manager.discover();
        assert_eq!(found.len(), 1);
        assert!(found[0].unrecognized);
        assert_eq!(found[0].name, "Unrecognized journal");
        assert!(manager.read_persisted("legacy-dir").is_err());
        // A v2 journal whose checkpoint is corrupt JSON.
        let items = vec![Item {
            local: "/s".into(),
            remote: "/d".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "corrupt-cp", &items, 0);
        let key = checkpoint_key("corrupt-cp", &items[0]);
        std::fs::write(
            root.join("corrupt-cp").join(format!("{key}.json")),
            "{not json",
        )
        .unwrap();
        assert!(manager.read_persisted("corrupt-cp").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discard_only_removes_valid_journal_directories() {
        let root = scratch();
        std::fs::create_dir_all(root.join("keep-me")).unwrap();
        std::fs::write(root.join("sentinel"), b"do not delete").unwrap();
        let manager = Transfers::with_root(root.clone());
        for bad in ["", ".", "..", "../keep-me", "/etc", "sub/dir", "a\\b"] {
            assert!(manager.discard_persisted(bad).is_err(), "{bad:?}");
        }
        // Nothing outside a valid id was touched.
        assert!(root.join("sentinel").exists());
        assert!(root.join("keep-me").exists());
        assert!(manager.discard_persisted("missing").is_err());
        manager.discard_persisted("keep-me").unwrap();
        assert!(!root.join("keep-me").exists());
        assert!(root.join("sentinel").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn discard_refuses_a_symlinked_journal_directory() {
        let root = scratch();
        let real = std::env::temp_dir().join(format!("real-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&real, root.join("linked")).unwrap();
        let manager = Transfers::with_root(root.clone());
        assert!(manager.discard_persisted("linked").is_err());
        assert!(manager.read_persisted("linked").is_err());
        assert!(manager.discover().is_empty());
        assert!(real.exists(), "the link target must survive");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[cfg(windows)]
    #[test]
    fn discard_refuses_a_junction_journal_directory() {
        let root = scratch();
        let real = std::env::temp_dir().join(format!("real-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("linked"))
            .arg(&real)
            .output()
            .expect("mklink /J needs no privilege");
        assert!(status.status.success(), "junction creation failed");
        let manager = Transfers::with_root(root.clone());
        assert!(manager.discard_persisted("linked").is_err());
        assert!(manager.read_persisted("linked").is_err());
        assert!(manager.discover().is_empty());
        assert!(real.exists(), "the junction target must survive");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn adopt_rejects_endpoint_and_kind_mismatches() {
        let root = scratch();
        let items = vec![Item {
            local: "/s".into(),
            remote: "/d".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "mismatch", &items, 0);
        let manager = Transfers::with_root(root.clone());
        let journal = manager.read_persisted("mismatch").unwrap();
        let mut other_host = sftp_profile();
        other_host.host = Some("elsewhere.example".into());
        assert!(manager
            .adopt(
                None,
                journal.clone(),
                "s".into(),
                other_host,
                Vec::new(),
                None,
                sink()
            )
            .is_err());
        let mut ftp = sftp_profile();
        ftp.kind = SessionKind::Ftp;
        assert!(manager
            .adopt(None, journal, "s".into(), ftp, Vec::new(), None, sink())
            .is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_skips_jobs_live_in_this_run() {
        let root = scratch();
        let items = vec![Item {
            local: "/s".into(),
            remote: "/d".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "live-job", &items, 0);
        let manager = Transfers::with_root(root.clone());
        assert!(manager
            .discover()
            .iter()
            .any(|found| found.id == "live-job"));
        // A job under that id in memory hides it from the list — built via
        // `rebuild` so no second journal directory appears beside it.
        let job = manager
            .rebuild(
                "live-job".into(),
                "s".into(),
                items,
                None,
                Options::default(),
                sftp_profile(),
                Vec::new(),
                None,
                root.join("live-job"),
                "d".into(),
                HashMap::new(),
                sink(),
                None,
            )
            .unwrap();
        manager.jobs.lock().insert("live-job".into(), job);
        assert!(manager
            .discover()
            .iter()
            .all(|found| found.id != "live-job"));
        assert!(manager.read_persisted("live-job").is_err());
        assert!(manager.discard_persisted("live-job").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
