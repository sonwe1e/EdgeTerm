use super::*;

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
    pub(super) snapshot: Mutex<Snapshot>,
    pub(super) progress: Mutex<HashMap<String, (u64, u64, bool)>>,
    pub(super) last_emit: Mutex<Instant>,
    pub(super) app: Option<AppHandle>,
    pub(super) targets: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub(super) plan: Mutex<Option<Vec<Item>>>,
    pub(super) lifecycle: Mutex<()>,
    pub(super) channel: Channel<TransferProgress>,
    pub(super) active: AtomicBool,
    pub(super) done: watch::Sender<Option<std::result::Result<(), String>>>,
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
    pub(super) fn status(&self, status: &str, error: Option<Failure>) {
        let mut snapshot = self.snapshot.lock();
        snapshot.status = status.into();
        snapshot.error = error;
        drop(snapshot);
        self.emit(true);
    }
    pub(super) fn emit(&self, force: bool) {
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
