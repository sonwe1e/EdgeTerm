use super::*;

#[derive(Default)]
pub struct Transfers {
    pub(super) jobs: Mutex<HashMap<String, Arc<Job>>>,
    pub(super) profiles: Mutex<HashMap<String, SessionProfile>>,
    /// Per-endpoint job slots: at most two jobs per endpoint run at once;
    /// the rest wait in the queue (and stay pausable/cancellable there).
    /// This is job-level concurrency — the per-job `files`/`requests`
    /// options are separate and live inside one running job.
    pub(super) limits: Mutex<HashMap<String, Arc<Semaphore>>>,
    pub(super) targets: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub(super) early_cancels: Mutex<HashMap<String, Instant>>,
    /// Journal root override. Production reads `transfers_root()`; tests
    /// inject a temporary directory so no test ever scans, writes or
    /// deletes a real user's journals.
    pub(super) root: Option<PathBuf>,
    #[cfg(test)]
    pub(super) test_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
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
    pub(super) fn root(&self) -> PathBuf {
        self.root.clone().unwrap_or_else(transfers_root)
    }
    /// End paused test runs without cancellation cleanup, as a process exit
    /// would. Call only after their I/O workers have reached the paused state.
    #[cfg(test)]
    pub(super) async fn stop_test_workers(&self) {
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
    pub(super) fn rebuild(
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
    pub(super) fn launch(&self, job: Arc<Job>) {
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
