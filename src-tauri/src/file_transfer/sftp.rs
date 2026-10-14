use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{
    future::Either,
    stream::{FuturesOrdered, FuturesUnordered},
    FutureExt, StreamExt, TryFutureExt,
};
use parking_lot::Mutex;
use ring::digest::{Context, SHA256};
use russh_sftp::client::{error::Error, rawsession::Limits, RawSftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use super::{local, Checkpoint, Control, Failure, Item, Job, TransferResult};
use crate::commands::AppState;
use crate::session::{
    auth::AuthPrompter,
    ssh::{connect_sftp, SftpConnectOutcome, SharedTransport},
    transfer::{ensure_local_directory, plan_local_upload_checked, safe_local_child},
};

#[cfg(test)]
#[path = "sftp_tests.rs"]
mod tests;

impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        let retry = matches!(
            &e,
            Error::Timeout | Error::IO(_) | Error::UnexpectedBehavior(_)
        ) || matches!(&e, Error::Status(s) if matches!(s.status_code, StatusCode::ConnectionLost | StatusCode::NoConnection));
        let code = match &e {
            Error::Timeout => "timeout",
            Error::Status(s) if s.status_code == StatusCode::PermissionDenied => "permission",
            _ if retry => "network",
            _ => "remote",
        };
        Failure::new(code, e, retry)
    }
}

struct Remote {
    raw: RawSftpSession,
    extensions: HashMap<String, String>,
    read_len: usize,
    write_len: usize,
    files: usize,
    requests: Semaphore,
    /// Target-directory listings captured during planning, keyed by
    /// resolved parent path. A destination name its parent's listing does
    /// not hold lets a fresh upload skip its per-file probe; a parent
    /// without a listing (a download, a direct copy, an unlistable
    /// directory) keeps the probe.
    listings: Mutex<HashMap<String, HashSet<String>>>,
    _transport: Option<Arc<SharedTransport>>,
}
impl Drop for Remote {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}
impl Remote {
    async fn connect(job: &Job) -> TransferResult<Arc<Self>> {
        job.control.check()?;
        job.phase("connecting");
        let existing = job.transport.lock().clone();
        let transport = match existing {
            Some(t) => t,
            None => {
                let prompt = AuthPrompter::background();
                let conn = job
                    .control
                    .run(async {
                        connect_sftp(&job.profile, &job.jumps, &prompt)
                            .await
                            .map_err(Failure::connection)
                    })
                    .await?;
                match conn {
                    SftpConnectOutcome::Ready(conn) => conn.transport(),
                    SftpConnectOutcome::HostKeyChanged(_) => return Err(Failure::new("hostKey", "host key changed; reconnect the session and review its host key before retrying", false)),
                }
            }
        };
        let stream = match job
            .control
            .run(async { transport.transfer_channel().await.map_err(Failure::network) })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                *job.transport.lock() = None;
                return Err(e);
            }
        };
        *job.transport.lock() = Some(transport.clone());
        let mut raw = RawSftpSession::new(stream);
        raw.set_timeout(25);
        let version = job
            .control
            .run(async { raw.init().await.map_err(Failure::from) })
            .await?;
        let mut limits = Limits::default();
        if version.extensions.contains_key("limits@openssh.com") {
            limits = job
                .control
                .run(async { raw.limits().await.map(Limits::from).map_err(Failure::from) })
                .await?;
            raw.set_limits(limits);
        }
        // Include packet framing and handle overhead, and stay conservative on
        // servers that don't advertise limits (network appliances in particular).
        let max_packet = limits.packet_len.unwrap_or(32 * 1024).saturating_sub(1024) as usize;
        let configured = job.options.chunk_kib * 1024;
        let read_len = configured
            .min(limits.read_len.unwrap_or(32 * 1024) as usize)
            .min(max_packet);
        let write_len = configured
            .min(limits.write_len.unwrap_or(32 * 1024) as usize)
            .min(max_packet);
        if read_len == 0 || write_len == 0 {
            return Err(Failure::new(
                "limits",
                "server reported an unusable packet limit",
                false,
            ));
        }
        Ok(Arc::new(Self {
            raw,
            extensions: version.extensions,
            read_len,
            write_len,
            files: match limits.open_handles {
                Some(n) => job.options.files.min((n / 2).max(1) as usize),
                // A server that does not advertise limits may be a
                // constrained appliance; keep the historical default
                // ceiling instead of the full configured width.
                None => job.options.files.min(4),
            },
            requests: Semaphore::new(job.options.requests),
            listings: Mutex::new(HashMap::new()),
            _transport: Some(transport),
        }))
    }
    async fn attrs(&self, path: &str, control: &Control) -> TransferResult<Option<FileAttributes>> {
        control
            .run(async {
                match self.raw.lstat(path).await {
                    Ok(v) => Ok(Some(v.attrs)),
                    Err(Error::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
                    Err(e) => Err(e.into()),
                }
            })
            .await
    }
    async fn open(
        &self,
        path: &str,
        flags: OpenFlags,
        control: &Control,
    ) -> TransferResult<String> {
        control
            .run(async {
                self.raw
                    .open(path, flags, FileAttributes::empty())
                    .await
                    .map(|v| v.handle)
                    .map_err(Failure::from)
            })
            .await
    }
    async fn close(&self, handle: &str) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.raw.close(handle)).await;
    }
    async fn read(
        &self,
        handle: &str,
        offset: u64,
        count: usize,
        control: &Control,
    ) -> TransferResult<Vec<u8>> {
        control
            .run(async {
                let _permit = self.requests.acquire().await.map_err(Failure::network)?;
                let mut result = Vec::with_capacity(count);
                // A short DATA packet is legal; only explicit EOF terminates a read.
                while result.len() < count {
                    let size = (count - result.len()).min(self.read_len);
                    let bytes = self
                        .raw
                        .read(handle, offset + result.len() as u64, size as u32)
                        .await?;
                    if bytes.data.is_empty() || bytes.data.len() > size {
                        return Err(Failure::conflict(
                            "unexpected short or oversized remote file",
                        ));
                    }
                    result.extend_from_slice(&bytes.data);
                }
                Ok(result)
            })
            .await
    }
    async fn write(
        &self,
        handle: &str,
        offset: u64,
        bytes: Vec<u8>,
        control: &Control,
    ) -> TransferResult<Vec<u8>> {
        control
            .run(async {
                let _permit = self.requests.acquire().await.map_err(Failure::network)?;
                self.raw.write(handle, offset, bytes.clone()).await?;
                Ok(bytes)
            })
            .await
    }
    async fn signature(
        &self,
        path: &str,
        control: &Control,
    ) -> TransferResult<Option<local::Signature>> {
        self.file_signature(path, control, false).await
    }
    async fn source_signature(
        &self,
        path: &str,
        control: &Control,
    ) -> TransferResult<Option<local::Signature>> {
        self.file_signature(path, control, true).await
    }
    async fn file_signature(
        &self,
        path: &str,
        control: &Control,
        follow_source: bool,
    ) -> TransferResult<Option<local::Signature>> {
        let Some(mut meta) = self.attrs(path, control).await? else {
            return Ok(None);
        };
        if meta.is_symlink() && follow_source {
            meta = control
                .run(async {
                    self.raw
                        .stat(path)
                        .await
                        .map(|v| v.attrs)
                        .map_err(Failure::from)
                })
                .await?;
        }
        if meta.is_symlink() || meta.is_dir() {
            return Err(Failure::conflict(format!(
                "refusing to replace remote symlink or directory: {path}"
            )));
        }
        let size = meta
            .size
            .ok_or_else(|| Failure::conflict("server did not report file size"))?;
        let handle = self.open(path, OpenFlags::READ, control).await?;
        let result = async {
            let mut context = Context::new(&SHA256);
            let length = size.min(64 * 1024) as usize;
            let tail = size.saturating_sub(length as u64);
            let head = self.read(&handle, 0, length, control).await?;
            context.update(&head);
            // A file that fits in one sample has the same bytes at both ends.
            // They are still hashed twice, so the signature a checkpoint holds
            // is unchanged, but the second read would only fetch them again.
            if tail == 0 {
                context.update(&head);
            } else {
                context.update(&self.read(&handle, tail, length, control).await?);
            }
            Ok(Some(local::Signature {
                size,
                modified: meta.mtime.map(|v| v as u128),
                sample: local::hex(context.finish().as_ref()),
            }))
        }
        .await;
        self.close(&handle).await;
        result
    }
    async fn hash(&self, path: &str, size: u64, control: &Control) -> TransferResult<String> {
        let handle = self.open(path, OpenFlags::READ, control).await?;
        let result = async {
            let mut context = Context::new(&SHA256);
            let mut next = 0;
            let mut reads = FuturesOrdered::new();
            loop {
                while reads.len() < 8 && next < size {
                    let length = (size - next).min(self.read_len as u64) as usize;
                    reads.push_back(self.read(&handle, next, length, control));
                    next += length as u64;
                }
                let Some(bytes) = reads.next().await else {
                    break;
                };
                let bytes = bytes?;
                context.update(&bytes);
            }
            Ok(local::hex(context.finish().as_ref()))
        }
        .await;
        self.close(&handle).await;
        result
    }
    /// Creates a directory, reporting whether this call created it. A
    /// directory that already existed reports `false`: its contents are
    /// unknown to the plan, unlike a directory created a moment ago.
    async fn mkdir(&self, path: &str, control: &Control) -> TransferResult<bool> {
        // The mkdir is issued without a probing stat: creating a fresh
        // directory is the common case and costs one round trip. Servers
        // answer "failure" both for real errors and for an existing
        // directory, so only then is a stat spent to tell them apart.
        control
            .run(async {
                match self.raw.mkdir(path, FileAttributes::empty()).await {
                    Ok(_) => Ok(true),
                    Err(Error::Status(s)) if s.status_code == StatusCode::Failure => {
                        match self.raw.lstat(path).await {
                            Ok(v) if v.attrs.is_dir() && !v.attrs.is_symlink() => Ok(false),
                            Ok(_) => Err(Failure::conflict(format!(
                                "target is not a real directory: {path}"
                            ))),
                            Err(e) => Err(e.into()),
                        }
                    }
                    Err(e) => Err(e.into()),
                }
            })
            .await
    }
    async fn list(
        &self,
        path: &str,
        control: &Control,
    ) -> TransferResult<Vec<russh_sftp::protocol::File>> {
        let handle = control
            .run(async {
                self.raw
                    .opendir(path)
                    .await
                    .map(|v| v.handle)
                    .map_err(Failure::from)
            })
            .await?;
        let result = async {
            let mut entries = Vec::new();
            loop {
                let page = control
                    .run(async {
                        match self.raw.readdir(&handle).await {
                            Ok(v) => Ok(Some(v.files)),
                            Err(Error::Status(s)) if s.status_code == StatusCode::Eof => Ok(None),
                            Err(e) => Err(e.into()),
                        }
                    })
                    .await?;
                match page {
                    Some(mut files) => entries.append(&mut files),
                    None => break,
                }
            }
            Ok(entries)
        }
        .await;
        self.close(&handle).await;
        result
    }
    /// Records the planning listings, keyed by resolved parent path.
    fn set_listings(&self, listings: HashMap<String, HashSet<String>>) {
        *self.listings.lock() = listings;
    }
    /// Whether planning's listing of the destination's parent proves the
    /// destination does not exist yet. An unlisted parent keeps the
    /// per-file probe.
    fn listing_shows_absent(&self, path: &str) -> bool {
        let Some((parent, name)) = path.rsplit_once('/') else {
            return false;
        };
        let parent = if parent.is_empty() { "/" } else { parent };
        matches!(self.listings.lock().get(parent), Some(names) if !names.contains(name))
    }
}

pub async fn run(job: &Arc<Job>) -> TransferResult<()> {
    let remote = Remote::connect(job).await?;
    job.phase("scanning");
    let files = plan(job, &remote).await?;
    copy_files(job, &remote, files).await
}

async fn copy_files(job: &Job, remote: &Remote, files: Vec<Item>) -> TransferResult<()> {
    let parallel = remote.files.min(files.len()).max(1);
    let depth = (job.options.requests / parallel).max(1);
    let large = Semaphore::new(2);
    let mut pending = files.into_iter();
    let mut active = FuturesUnordered::new();
    let mut failures = Vec::new();
    for _ in 0..parallel {
        if let Some(item) = pending.next() {
            active.push(copy(job, &remote, item, depth, &large));
        }
    }
    job.phase("transferring");
    while let Some(result) = active.next().await {
        if let Err(e) = result {
            if !e.stopped() {
                failures.push(e);
            }
        }
        // Drain existing workers on pause/cancel. Dropping another file's
        // in-progress rename would leave the destination state ambiguous.
        if job.control.value() == 0 {
            if let Some(item) = pending.next() {
                active.push(copy(job, &remote, item, depth, &large));
            }
        }
    }
    job.control.check()?;
    if let Some(error) = failures.iter().find(|e| e.retryable).or(failures.first()) {
        Err(error.clone())
    } else {
        Ok(())
    }
}

/// How many directory creations or parent resolutions stay in flight at
/// once during planning. OpenSSH's sftp-server (and most servers) process
/// one channel's requests in order, so a parent is created before the
/// children behind it arrive; `create_directories` still recovers on a
/// server that does not.
const PLAN_WINDOW: usize = 8;

/// Creates the planned directories parents-first, keeping a window of
/// mkdirs in flight. A child whose parent mkdir is still in flight fails
/// on a server that processes requests out of order. Drain each batch while
/// retaining every failure, then retry those directories in parent-first
/// order before opening the next batch. Returns the directories this call
/// actually created; a directory that already existed is not returned,
/// because its contents are unknown to the plan.
async fn create_directories(
    job: &Job,
    remote: &Remote,
    directories: &[String],
) -> TransferResult<HashSet<String>> {
    let mut created = HashSet::new();
    for batch in directories.chunks(PLAN_WINDOW) {
        job.control.check()?;
        let mut creates = FuturesOrdered::new();
        for path in batch {
            creates.push_back(async move {
                remote
                    .mkdir(path, &job.control)
                    .await
                    .map(|made| (path.clone(), made))
                    .map_err(|e| (path, e))
            });
        }
        let mut failed = Vec::new();
        while let Some(result) = creates.next().await {
            match result {
                Ok((path, true)) => {
                    created.insert(path);
                }
                // A directory that already existed: its contents are
                // unknown, so its files keep their destination probe.
                Ok((_, false)) => {}
                Err((path, e)) => {
                    if e.stopped() {
                        return Err(e);
                    }
                    failed.push(path);
                }
            }
        }
        // Draining must retain ALL failures. Retry in the plan's parent-first
        // order, including children that failed while their parent was absent.
        for path in failed {
            if remote.mkdir(path, &job.control).await? {
                created.insert(path.to_string());
            }
        }
    }
    Ok(created)
}

async fn plan(job: &Job, remote: &Remote) -> TransferResult<Vec<Item>> {
    if let Some(plan) = job.plan.lock().clone() {
        return Ok(plan);
    }
    let mut files = Vec::new();
    let mut sizes = Vec::new();
    // Directories this plan creates. They are empty by construction, so
    // their files need no destination listing.
    let mut created = HashSet::new();
    for item in &job.items {
        job.control.check()?;
        let directory = item.directory || (item.upload && std::fs::metadata(&item.local)?.is_dir());
        if !directory {
            sizes.push(if item.upload {
                std::fs::metadata(&item.local)?.len()
            } else {
                remote
                    .attrs(&item.remote, &job.control)
                    .await?
                    .and_then(|m| m.size)
                    .unwrap_or(0)
            });
            files.push(item.clone());
            continue;
        }
        if item.upload {
            let root = PathBuf::from(&item.local);
            let dest = item.remote.clone();
            let control = job.control.clone();
            let plan = tokio::task::spawn_blocking(move || {
                plan_local_upload_checked(&root, &dest, || control.check().map_err(Into::into))
            })
            .await
            .map_err(Failure::local)?
            .map_err(Failure::local)?;
            create_directories(job, remote, &plan.directories)
                .await?
                .into_iter()
                .for_each(|path| {
                    created.insert(path);
                });
            for file in plan.files {
                sizes.push(file.size);
                files.push(Item {
                    local: file.local.to_string_lossy().into(),
                    remote: file.remote,
                    upload: true,
                    directory: false,
                });
            }
        } else {
            let mut directories = vec![(item.remote.clone(), PathBuf::from(&item.local))];
            while let Some((path, local)) = directories.pop() {
                job.control.check()?;
                ensure_local_directory(&local).map_err(Failure::local)?;
                for entry in remote.list(&path, &job.control).await? {
                    if matches!(entry.filename.as_str(), "." | "..") {
                        continue;
                    }
                    let child =
                        safe_local_child(&local, &entry.filename).map_err(Failure::conflict)?;
                    let remote_child = crate::session::join_remote(&path, &entry.filename);
                    // Directory links must never create a cycle or escape the tree.
                    let mut attrs = entry.attrs;
                    if attrs.is_symlink() {
                        attrs = match job
                            .control
                            .run(async {
                                remote
                                    .raw
                                    .stat(&remote_child)
                                    .await
                                    .map(|v| v.attrs)
                                    .map_err(Failure::from)
                            })
                            .await
                        {
                            Ok(attrs) if !attrs.is_dir() => attrs,
                            Ok(_) => continue,
                            Err(error) => return Err(error),
                        };
                    }
                    if attrs.is_dir() {
                        directories.push((remote_child, child));
                    } else {
                        sizes.push(attrs.size.unwrap_or(0));
                        files.push(Item {
                            local: child.to_string_lossy().into(),
                            remote: remote_child,
                            upload: false,
                            directory: false,
                        });
                    }
                }
            }
        }
    }
    // Duplicate destinations in one batch are rejected before any file is written.
    let mut destinations = std::collections::HashSet::new();
    // Resolve every distinct parent up front and in parallel: a project
    // with many folders would otherwise pay one round-trip latency per
    // folder before the first byte moves.
    let mut unique_parents = Vec::new();
    {
        let mut seen = std::collections::HashSet::new();
        for item in &files {
            let (parent, _) = item
                .remote
                .rsplit_once('/')
                .unwrap_or((".", item.remote.as_str()));
            let parent = if parent.is_empty() { "/" } else { parent };
            if seen.insert(parent.to_string()) {
                unique_parents.push(parent.to_string());
            }
        }
    }
    let mut parents = HashMap::new();
    {
        let mut queue = unique_parents.into_iter();
        let mut resolves = FuturesOrdered::new();
        loop {
            job.control.check()?;
            while resolves.len() < PLAN_WINDOW {
                let Some(parent) = queue.next() else { break };
                resolves.push_back(async move {
                    job.control
                        .run(async { remote.raw.realpath(&parent).await.map_err(Failure::from) })
                        .await
                        .map(|resolved| (parent, resolved))
                });
            }
            let Some(result) = resolves.next().await else {
                break;
            };
            let (parent, resolved) = result?;
            let path = resolved
                .files
                .first()
                .ok_or_else(|| Failure::conflict("remote parent could not be resolved"))?
                .filename
                .clone();
            parents.insert(parent, path);
        }
    }
    for item in &mut files {
        job.control.check()?;
        item.local = local::normalize(&item.local)?;
        let (parent, name) = item
            .remote
            .rsplit_once('/')
            .unwrap_or((".", item.remote.as_str()));
        let parent = if parent.is_empty() { "/" } else { parent };
        let resolved = parents
            .get(parent)
            .ok_or_else(|| Failure::conflict("remote parent could not be resolved"))?;
        item.remote = crate::session::join_remote(resolved, name);
        let target = super::target_key(&job.profile, item);
        if !destinations.insert(target) {
            return Err(Failure::conflict("batch contains duplicate destinations"));
        }
    }
    // Read every distinct target parent this plan did not just create,
    // once, in a window. The listing answers each file's destination
    // probe: a name the listing does not hold is a fresh upload target.
    let mut wanted = Vec::new();
    {
        let mut seen = HashSet::new();
        for item in &files {
            if !item.upload {
                continue;
            }
            let (parent, _) = item
                .remote
                .rsplit_once('/')
                .unwrap_or((".", item.remote.as_str()));
            let parent = if parent.is_empty() { "/" } else { parent };
            if !created.contains(parent) && seen.insert(parent.to_string()) {
                wanted.push(parent.to_string());
            }
        }
    }
    if !wanted.is_empty() || !created.is_empty() {
        let mut listings: HashMap<String, HashSet<String>> = HashMap::new();
        let mut queue = wanted.into_iter();
        let mut lists = FuturesOrdered::new();
        loop {
            job.control.check()?;
            while lists.len() < PLAN_WINDOW {
                let Some(parent) = queue.next() else { break };
                lists.push_back(async move {
                    let entries = remote.list(&parent, &job.control).await;
                    (parent, entries)
                });
            }
            let Some((parent, entries)) = lists.next().await else {
                break;
            };
            match entries {
                Ok(entries) => {
                    listings.insert(
                        parent,
                        entries.into_iter().map(|entry| entry.filename).collect(),
                    );
                }
                // A parent that cannot be listed keeps the per-file probe
                // for its files instead of failing the whole plan.
                Err(e) if e.stopped() => return Err(e),
                Err(_) => {}
            }
        }
        // A directory this plan created is empty by construction, so its
        // files need no listing of their own.
        for path in created {
            listings.entry(path).or_default();
        }
        remote.set_listings(listings);
    }
    for (item, size) in files.iter().zip(sizes) {
        job.progress(&job.key(item), 0, size, false);
    }
    *job.plan.lock() = Some(files.clone());
    Ok(files)
}

async fn copy(
    job: &Job,
    remote: &Remote,
    item: Item,
    depth: usize,
    large: &Semaphore,
) -> TransferResult<()> {
    let key = job.key(&item);
    let outcome = async {
        job.control.check()?;
        if item.upload && job.options.durable && !remote.extensions.contains_key("fsync@openssh.com") {
            return Err(Failure::new("unsupported", "this SFTP server does not support durable uploads (fsync); disable Durable writes to transfer without it", false));
        }
        let _target_lock = job.lock_target(&item).await?;
        let source = if item.upload {
            local::signature(Path::new(&item.local))?
        } else {
            remote
                .source_signature(&item.remote, &job.control)
                .await?
                .ok_or_else(|| Failure::conflict("source disappeared"))?
        };
        let _large = if source.size >= 16 * 1024 * 1024 {
            Some(
                job.control
                    .run(async { large.acquire().await.map_err(Failure::network) })
                    .await?,
            )
        } else {
            None
        };
        // Whether this run resumes a journaled file or starts a fresh one,
        // and whether that fresh file journals only its start and its end.
        let resumed = job.checkpoint(&key).is_some();
        let mut coalesced = false;
        let mut cp = if let Some(cp) = job.checkpoint(&key) {
            if cp.source != source {
                return Err(Failure::conflict(format!(
                    "source changed; start a new transfer: {}",
                    item.local
                )));
            }
            cp
        } else {
            let original = if item.upload {
                // Planning listed the destination's parent; a name the
                // listing does not hold needs no probe of its own.
                if remote.listing_shows_absent(&item.remote) {
                    None
                } else {
                    remote.signature(&item.remote, &job.control).await?
                }
            } else {
                local::target_signature(Path::new(&item.local))?
            };
            let (temporary, backup) = if item.upload {
                let parent = item.remote.rsplit_once('/').map(|v| v.0).unwrap_or(".");
                (
                    format!("{parent}/.edgeterm-{key}.part"),
                    format!("{parent}/.edgeterm-{key}.backup"),
                )
            } else {
                (
                    local::sibling(Path::new(&item.local), &key, "part")?
                        .to_string_lossy()
                        .into(),
                    String::new(),
                )
            };
            // A fresh file that fits in one write journals twice: the
            // checkpoint that claims the partial, and the completion. Its
            // intermediate states each cost a blocking disk write and buy
            // nothing a restart cannot redo, because a restart re-sends the
            // whole file. A destination that already exists, and a file past
            // the first chunk, keep every checkpoint: their resume prefix is
            // worth the write.
            let coalesced_now = original.is_none() && source.size <= remote.write_len as u64;
            coalesced = coalesced_now;
            let cp = Checkpoint {
                key: key.clone(),
                item: item.clone(),
                source: source.clone(),
                original,
                temporary,
                backup,
                offset: 0,
                prefix_hash: local::digest(&[]),
                complete: false,
                committing: false,
                // Ownership is recorded before the partial exists: the
                // exclusive open below can only create it, never adopt one,
                // and a crash can no longer leave an owned `.part` the
                // journal never recorded.
                owns_temporary: coalesced_now,
                owns_backup: false,
            };
            // Persist ownership before creating the partial; unknown partials
            // are never adopted based on their filename or size alone.
            job.save_async(&cp).await?;
            cp
        };
        let mut handle: Option<String> = None;
        if item.upload {
            if !resumed {
                let h = remote
                    .open(
                        &cp.temporary,
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        &job.control,
                    )
                    .await?;
                if !cp.owns_temporary {
                    cp.owns_temporary = true;
                    if !coalesced {
                        job.save_async(&cp).await?;
                    }
                }
                // The write path keeps this handle: closing the placeholder
                // only to reopen it costs two round trips per file.
                handle = Some(h);
            }
        } else if !cp.owns_temporary || !resumed {
            // A coalesced checkpoint already recorded ownership of the
            // partial; the file itself still has to exist before the write
            // path opens it. A resumed partial is left exactly as it is.
            local::create_partial(Path::new(&cp.temporary))?;
            if !cp.owns_temporary {
                cp.owns_temporary = true;
                if !coalesced {
                    job.save_async(&cp).await?;
                }
            }
        }
        job.progress(&key, cp.offset, source.size, cp.complete);
        if cp.complete {
            return Ok(());
        }
        if cp.committing && recover_commit(job, remote, &mut cp).await? {
            return Ok(());
        }
        if item.upload {
            upload(job, remote, &mut cp, depth, handle, coalesced).await?;
        } else {
            download(job, remote, &mut cp, depth, coalesced).await?;
        }
        // A recovery path can finish the file inside the transfer itself: the
        // journal did not record the commit, and the destination already holds
        // exactly the bytes this job wrote.
        if cp.complete {
            return Ok(());
        }
        let current = if item.upload {
            Some(local::signature(Path::new(&item.local))?)
        } else {
            remote.source_signature(&item.remote, &job.control).await?
        };
        if current.as_ref() != Some(&cp.source) {
            return Err(Failure::conflict("source changed during transfer"));
        }
        commit(job, remote, &mut cp, coalesced).await
    }
    .await;
    if let Err(e) = &outcome {
        if !e.stopped() {
            job.failure(
                if item.upload {
                    &item.remote
                } else {
                    &item.local
                },
                e,
            );
        }
    }
    outcome
}

async fn download(
    job: &Job,
    remote: &Remote,
    cp: &mut Checkpoint,
    depth: usize,
    coalesced: bool,
) -> TransferResult<()> {
    crate::session::transfer::validate_local_file_target(Path::new(&cp.temporary))
        .map_err(Failure::conflict)?;
    // The partial is gone: either the commit already replaced the target and
    // crashed before journaling the completion, or something removed it. Only
    // the first counts as done — see `recover_renamed_download`.
    if !Path::new(&cp.temporary).exists() && recover_renamed_download(job, remote, cp).await? {
        return Ok(());
    }
    let mut hash = local::prefix_async(Path::new(&cp.temporary), cp.offset, &job.control).await?;
    if local::hex(hash.clone().finish().as_ref()) != cp.prefix_hash {
        return Err(Failure::conflict("local partial content changed"));
    }
    let mut target = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&cp.temporary)
        .await?;
    target.set_len(cp.offset).await?;
    target.seek(std::io::SeekFrom::Start(cp.offset)).await?;
    let handle = remote
        .open(&cp.item.remote, OpenFlags::READ, &job.control)
        .await?;
    let result = async {
        let mut reads = FuturesOrdered::new();
        let mut next = cp.offset;
        let mut saved = cp.offset;
        loop {
            while reads.len() < depth && next < cp.source.size {
                let length = (cp.source.size - next).min(remote.read_len as u64) as usize;
                reads.push_back(remote.read(&handle, next, length, &job.control));
                next += length as u64;
            }
            let Some(bytes) = reads.next().await else {
                break;
            };
            let bytes = bytes?;
            job.control
                .run(async { target.write_all(&bytes).await.map_err(Failure::from) })
                .await?;
            hash.update(&bytes);
            cp.offset += bytes.len() as u64;
            job.progress(&cp.key, cp.offset, cp.source.size, false);
            if cp.offset - saved >= 4 * 1024 * 1024 || cp.offset == cp.source.size {
                job.control
                    .run(async { target.sync_data().await.map_err(Failure::from) })
                    .await?;
                cp.prefix_hash = local::hex(hash.clone().finish().as_ref());
                if !coalesced {
                    job.save_async(cp).await?;
                }
                saved = cp.offset;
            }
        }
        // Empty files need a durable checkpoint as well.
        job.control
            .run(async { target.sync_all().await.map_err(Failure::from) })
            .await?;
        cp.prefix_hash = local::hex(hash.finish().as_ref());
        if !coalesced {
            job.save_async(cp).await
        } else {
            Ok(())
        }
    }
    .await;
    remote.close(&handle).await;
    result
}

/// One finished step of the pipelined write sequence: an acknowledged
/// chunk, or the close that was queued behind the final ones.
enum Step {
    Written(Vec<u8>),
    Closed,
}

async fn upload(
    job: &Job,
    remote: &Remote,
    cp: &mut Checkpoint,
    depth: usize,
    fresh_handle: Option<String>,
    coalesced: bool,
) -> TransferResult<()> {
    let mut hash = local::prefix_async(Path::new(&cp.item.local), cp.offset, &job.control).await?;
    if local::hex(hash.clone().finish().as_ref()) != cp.prefix_hash {
        return Err(Failure::conflict("source prefix changed"));
    }
    // A handle from this run's placeholder open proves the partial is a
    // fresh, zero-length file this job owns; re-statting it and truncating
    // it back to the offset it was created at would both be extra round
    // trips on every small-file upload.
    let fresh = fresh_handle.is_some() && cp.offset == 0;
    let handle = match fresh_handle {
        Some(h) if cp.offset == 0 => h,
        _ => {
            let Some(meta) = remote.attrs(&cp.temporary, &job.control).await? else {
                // The partial is gone. Either this job already renamed it
                // into place and crashed before journaling the completion,
                // or something removed it. Only the first counts as done:
                // the destination then holds exactly the bytes this job
                // wrote — see `recover_renamed_partial`.
                if recover_renamed_partial(job, remote, cp).await? {
                    return Ok(());
                }
                return Err(Failure::conflict("remote partial disappeared"));
            };
            if meta.is_symlink() || meta.is_dir() || meta.size.unwrap_or(0) < cp.offset {
                return Err(Failure::conflict("remote partial is invalid"));
            }
            if cp.offset > 0 {
                job.phase("verifying resume prefix");
                if remote.hash(&cp.temporary, cp.offset, &job.control).await? != cp.prefix_hash {
                    return Err(Failure::conflict("remote partial checkpoint changed"));
                }
            }
            remote
                .open(&cp.temporary, OpenFlags::WRITE, &job.control)
                .await?
        }
    };
    let result = async {
        let mut source = tokio::fs::File::open(&cp.item.local).await?;
        if !fresh {
            // Resume: drop any unconfirmed tail beyond the checkpointed
            // prefix before appending to it.
            job.control
                .run(async {
                    remote
                        .raw
                        .fsetstat(
                            &handle,
                            FileAttributes {
                                size: Some(cp.offset),
                                ..FileAttributes::empty()
                            },
                        )
                        .await
                        .map(|_| ())
                        .map_err(Failure::from)
                })
                .await?;
        }
        source.seek(std::io::SeekFrom::Start(cp.offset)).await?;
        // The close is queued behind the final writes instead of waiting
        // for their acknowledgements: a server processes one session's
        // requests in order, so the handle stays valid until the pending
        // writes are done (draft-ietf-secsh-filexfer-02 §6.1). Every write
        // acknowledgement is still checked before the file is committed,
        // and a durable upload still flushes before its close.
        let mut writes: FuturesOrdered<Either<_, _>> = FuturesOrdered::new();
        let mut next = cp.offset;
        let mut saved = cp.offset;
        let mut closing = false;
        loop {
            while writes.len() < depth && next < cp.source.size {
                let length = (cp.source.size - next).min(remote.write_len as u64) as usize;
                let mut bytes = vec![0; length];
                job.control
                    .run(async {
                        source
                            .read_exact(&mut bytes)
                            .await
                            .map(|_| ())
                            .map_err(Failure::from)
                    })
                    .await?;
                writes.push_back(Either::Left(
                    remote
                        .write(&handle, next, bytes, &job.control)
                        .map_ok(Step::Written),
                ));
                next += length as u64;
            }
            if next >= cp.source.size && !closing && !job.options.durable {
                closing = true;
                writes.push_back(Either::Right(
                    job.control
                        .run(async {
                            remote
                                .raw
                                .close(&handle)
                                .await
                                .map(|_| ())
                                .map_err(Failure::from)
                        })
                        .map(|result| result.map(|()| Step::Closed)),
                ));
            }
            let Some(step) = writes.next().await else {
                break;
            };
            match step? {
                Step::Written(bytes) => {
                    // FuturesOrdered only advances after all preceding
                    // ACKs, even if the server acknowledged later offsets
                    // first.
                    hash.update(&bytes);
                    cp.offset += bytes.len() as u64;
                    job.progress(&cp.key, cp.offset, cp.source.size, false);
                    if cp.offset - saved >= 4 * 1024 * 1024 || cp.offset == cp.source.size {
                        cp.prefix_hash = local::hex(hash.clone().finish().as_ref());
                        if !coalesced {
                            job.save_async(cp).await?;
                        }
                        saved = cp.offset;
                    }
                }
                Step::Closed => {}
            }
        }
        // fsync waits for the server's disk on every file; it is opt-in so
        // small-file batches are not paced by it. Unsupported servers are
        // rejected before writing; never silently weaken this option.
        if job.options.durable {
            job.control
                .run(async {
                    remote
                        .raw
                        .fsync(&handle)
                        .await
                        .map(|_| ())
                        .map_err(Failure::from)
                })
                .await?;
        }
        if !closing {
            job.control
                .run(async {
                    remote
                        .raw
                        .close(&handle)
                        .await
                        .map(|_| ())
                        .map_err(Failure::from)
                })
                .await?;
        }
        cp.prefix_hash = local::hex(hash.finish().as_ref());
        if !coalesced {
            job.save_async(cp).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        remote.close(&handle).await;
    }
    result
}

/// A coalesced journal does not record the commit, so a retry can find the
/// partial renamed away with the completion unsaved. The job counts the file
/// as done when the destination holds exactly the bytes this job wrote: the
/// same size and the same digest as the local source. Anything else — a
/// destination that never appeared, a different size, different bytes — is
/// `false`, and the caller reports the partial as disappeared.
async fn recover_renamed_partial(
    job: &Job,
    remote: &Remote,
    cp: &mut Checkpoint,
) -> TransferResult<bool> {
    let Some(meta) = remote.attrs(&cp.item.remote, &job.control).await? else {
        return Ok(false);
    };
    if meta.is_symlink() || meta.is_dir() || meta.size != Some(cp.source.size) {
        return Ok(false);
    }
    let context =
        local::prefix_async(Path::new(&cp.item.local), cp.source.size, &job.control).await?;
    if remote
        .hash(&cp.item.remote, cp.source.size, &job.control)
        .await?
        != local::hex(context.finish().as_ref())
    {
        return Ok(false);
    }
    cp.complete = true;
    job.save_async(cp).await?;
    job.progress(&cp.key, cp.source.size, cp.source.size, true);
    Ok(true)
}

/// The download side of `recover_renamed_partial`: the local partial is gone,
/// so the file counts as done when the local destination already holds the
/// source's bytes.
async fn recover_renamed_download(
    job: &Job,
    remote: &Remote,
    cp: &mut Checkpoint,
) -> TransferResult<bool> {
    let Ok(meta) = std::fs::symlink_metadata(&cp.item.local) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.len() != cp.source.size {
        return Ok(false);
    }
    let context =
        local::prefix_async(Path::new(&cp.item.local), cp.source.size, &job.control).await?;
    if remote
        .hash(&cp.item.remote, cp.source.size, &job.control)
        .await?
        != local::hex(context.finish().as_ref())
    {
        return Ok(false);
    }
    cp.complete = true;
    job.save_async(cp).await?;
    job.progress(&cp.key, cp.source.size, cp.source.size, true);
    Ok(true)
}

async fn recover_commit(job: &Job, remote: &Remote, cp: &mut Checkpoint) -> TransferResult<bool> {
    if cp.item.upload {
        if remote.attrs(&cp.temporary, &job.control).await?.is_some() {
            return Ok(false);
        }
        if remote
            .attrs(&cp.item.remote, &job.control)
            .await?
            .and_then(|m| m.size)
            != Some(cp.source.size)
            || remote
                .hash(&cp.item.remote, cp.source.size, &job.control)
                .await?
                != cp.prefix_hash
        {
            return Err(Failure::conflict(
                "cannot verify the result of the interrupted remote commit",
            ));
        }
    } else {
        if Path::new(&cp.temporary).exists() {
            return Ok(false);
        }
        if std::fs::metadata(&cp.item.local)?.len() != cp.source.size
            || local::hex(
                local::prefix_async(Path::new(&cp.item.local), cp.source.size, &job.control)
                    .await?
                    .finish()
                    .as_ref(),
            ) != cp.prefix_hash
        {
            return Err(Failure::conflict(
                "cannot verify the result of the interrupted local commit",
            ));
        }
    }
    remove_backup(remote, cp, &job.control).await?;
    cp.complete = true;
    job.save_async(cp).await?;
    job.progress(&cp.key, cp.source.size, cp.source.size, true);
    Ok(true)
}

async fn commit(
    job: &Job,
    remote: &Remote,
    cp: &mut Checkpoint,
    coalesced: bool,
) -> TransferResult<()> {
    job.control.check()?;
    // A recovery path can mark the file complete inside the transfer itself.
    if cp.complete {
        return Ok(());
    }
    job.phase("committing");
    if cp.item.upload {
        let current = remote.signature(&cp.item.remote, &job.control).await?;
        // When nothing was ever moved out of the way, no backup can exist
        // and the lookup would only cost a round trip per file.
        let backup = if cp.original.is_none() && !cp.owns_backup {
            None
        } else {
            remote.signature(&cp.backup, &job.control).await?
        };
        let recovering_backup = cp.committing
            && cp.owns_backup
            && current.is_none()
            && backup == cp.original
            && backup.is_some();
        if !recovering_backup && current != cp.original {
            return Err(Failure::conflict(
                "remote destination changed during transfer",
            ));
        }
        // Preserve the destination's permission bits when replacing it. A
        // destination that never existed has nothing to preserve, so the
        // stat is skipped entirely on the fresh-upload fast path.
        if cp.original.is_some() || recovering_backup {
            if let Some(meta) = remote
                .attrs(
                    if recovering_backup {
                        &cp.backup
                    } else {
                        &cp.item.remote
                    },
                    &job.control,
                )
                .await?
            {
                if let Some(permissions) = meta.permissions {
                    job.control
                        .run(async {
                            remote
                                .raw
                                .setstat(
                                    &cp.temporary,
                                    FileAttributes {
                                        permissions: Some(permissions),
                                        ..FileAttributes::empty()
                                    },
                                )
                                .await
                                .map(|_| ())
                                .map_err(Failure::from)
                        })
                        .await?;
                }
            }
        }
        cp.committing = true;
        // A coalesced journal does not record the commit: a crash before the
        // rename is redone from scratch, and a crash after it is recognised
        // by the destination holding this job's bytes (see
        // `recover_renamed_partial`).
        if !coalesced {
            job.save_async(cp).await?;
        }
        // A destination that did not exist when the transfer started must not
        // be replaced by anything that appears before the rename. posix-rename
        // overwrites, so the check above would leave a window; the plain
        // rename refuses an existing target. Replacing a file this transfer
        // saw (or recovering its backup) still uses posix-rename.
        let fresh = cp.original.is_none() && !recovering_backup;
        if !fresh && remote.extensions.contains_key("posix-rename@openssh.com") {
            let mut data = Vec::new();
            for path in [&cp.temporary, &cp.item.remote] {
                data.extend_from_slice(&(path.len() as u32).to_be_bytes());
                data.extend_from_slice(path.as_bytes());
            }
            job.control
                .run(async {
                    match remote
                        .raw
                        .extended("posix-rename@openssh.com", data)
                        .await?
                    {
                        Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
                        Packet::Status(s) => Err(Error::Status(s).into()),
                        _ => Err(Failure::new("protocol", "invalid rename response", false)),
                    }
                })
                .await?;
        } else {
            if current.is_some() {
                if backup.is_some() {
                    return Err(Failure::conflict("remote backup already exists"));
                }
                cp.owns_backup = true;
                job.save_async(cp).await?;
                job.control
                    .run(async {
                        remote
                            .raw
                            .rename(&cp.item.remote, &cp.backup)
                            .await
                            .map(|_| ())
                            .map_err(Failure::from)
                    })
                    .await?;
            }
            // Do not cancel between the two renames: finish or restore the old
            // file. Raw requests still have their own bounded timeout.
            if let Err(e) = remote.raw.rename(&cp.temporary, &cp.item.remote).await {
                if (current.is_some() || recovering_backup)
                    && matches!(remote.raw.lstat(&cp.item.remote).await, Err(Error::Status(s)) if s.status_code == StatusCode::NoSuchFile)
                {
                    let _ = remote.raw.rename(&cp.backup, &cp.item.remote).await;
                }
                // A refused rename of a fresh upload usually means the target
                // appeared meanwhile; say so instead of a bare server error.
                if fresh && remote.attrs(&cp.item.remote, &job.control).await?.is_some() {
                    return Err(Failure::conflict(
                        "remote destination changed during transfer",
                    ));
                }
                return Err(e.into());
            }
        }
        remove_backup(remote, cp, &job.control).await?;
        cp.complete = true;
        job.save_async(cp).await?;
    } else {
        if local::target_signature(Path::new(&cp.item.local))? != cp.original {
            return Err(Failure::conflict(
                "local destination changed during transfer",
            ));
        }
        if cp.original.is_some() {
            std::fs::set_permissions(
                &cp.temporary,
                std::fs::metadata(&cp.item.local)?.permissions(),
            )?;
        }
        cp.committing = true;
        if !coalesced {
            job.save_async(cp).await?;
        }
        local::replace(Path::new(&cp.temporary), Path::new(&cp.item.local))?;
        cp.complete = true;
        job.save_async(cp).await?;
    }
    job.progress(&cp.key, cp.source.size, cp.source.size, true);
    Ok(())
}

pub async fn cleanup(job: &Job) -> TransferResult<()> {
    let checkpoints: Vec<_> = job.checkpoints.lock().values().cloned().collect();
    let mut remote_paths = Vec::new();
    for mut cp in checkpoints {
        if cp.complete || !cp.owns_temporary {
            continue;
        }
        if cp.item.upload {
            remote_paths.push(cp);
        } else {
            if Path::new(&cp.temporary).exists() {
                std::fs::remove_file(&cp.temporary)?;
            }
            cp.owns_temporary = false;
            job.save_async(&cp).await?;
        }
    }
    if remote_paths.is_empty() {
        return Ok(());
    }
    // Cancellation never starts a new authentication conversation just to clean
    // a partial. Retain the journal and report the exact cleanup limitation.
    let current = job
        .app
        .as_ref()
        .and_then(|app| app.state::<AppState>().ssh_transports.get(&job.session_id));
    let transport = current
        .or_else(|| job.transport.lock().clone())
        .ok_or_else(|| {
            Failure::local("remote partials retained; reconnect and cancel again to clean them")
        })?;
    tokio::time::timeout(Duration::from_secs(5), async {
        let stream = transport
            .transfer_channel()
            .await
            .map_err(Failure::network)?;
        let raw = RawSftpSession::new(stream);
        raw.set_timeout(3);
        let extensions = raw.init().await?.extensions;
        let remote = Remote {
            raw,
            extensions,
            read_len: 31 * 1024,
            write_len: 31 * 1024,
            files: 1,
            requests: Semaphore::new(8),
            listings: Mutex::new(HashMap::new()),
            _transport: Some(transport),
        };
        cleanup_remote(&remote, remote_paths, Some(job)).await
    })
    .await
    .unwrap_or_else(|_| {
        Err(Failure::local(
            "remote cleanup timed out; partial paths are retained in the transfer journal",
        ))
    })
}

async fn remove_backup(
    remote: &Remote,
    cp: &mut Checkpoint,
    control: &Control,
) -> TransferResult<()> {
    if cp.owns_backup {
        if let Some(backup) = remote.signature(&cp.backup, control).await? {
            if Some(backup) != cp.original {
                return Err(Failure::conflict(
                    "backup changed; retained for manual recovery",
                ));
            }
            control
                .run(async {
                    remote
                        .raw
                        .remove(&cp.backup)
                        .await
                        .map(|_| ())
                        .map_err(Failure::from)
                })
                .await?;
        }
        cp.owns_backup = false;
    }
    Ok(())
}

async fn cleanup_remote(
    remote: &Remote,
    checkpoints: Vec<Checkpoint>,
    job: Option<&Job>,
) -> TransferResult<()> {
    let control = Control::default();
    for mut cp in checkpoints {
        if cp.committing && cp.owns_backup {
            let current = remote.signature(&cp.item.remote, &control).await?;
            if current.is_none() {
                if remote.signature(&cp.backup, &control).await? != cp.original
                    || cp.original.is_none()
                {
                    return Err(Failure::conflict(
                        "cannot verify the original backup; retained for manual recovery",
                    ));
                }
                remote.raw.rename(&cp.backup, &cp.item.remote).await?;
                cp.owns_backup = false;
            } else if current != cp.original
                && (current.as_ref().map(|s| s.size) != Some(cp.source.size)
                    || remote
                        .hash(&cp.item.remote, cp.source.size, &control)
                        .await?
                        != cp.prefix_hash)
            {
                return Err(Failure::conflict(
                    "destination changed during commit; backup and partial retained",
                ));
            }
            remove_backup(remote, &mut cp, &control).await?;
        }
        match remote.raw.remove(&cp.temporary).await {
            Ok(_) => {}
            Err(Error::Status(s)) if s.status_code == StatusCode::NoSuchFile => {}
            Err(e) => return Err(e.into()),
        }
        cp.owns_temporary = false;
        if let Some(job) = job {
            job.save_async(&cp).await?;
        }
    }
    Ok(())
}
