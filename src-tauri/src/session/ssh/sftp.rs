use super::*;

/// How often an SFTP-only session, which has no channel to read from, checks
/// that its transport is still alive so a dropped connection is reported.
pub(super) const SFTP_HEALTH_INTERVAL: Duration = Duration::from_secs(5);

/// How long a server gets to accept or refuse the sftp subsystem; see
/// `ensure_sftp`. Servers answer at once, so this only bounds a stuck one.
pub(super) const SFTP_SUBSYSTEM_TIMEOUT: Duration = Duration::from_secs(5);

/// An SSH transport that carries only the SFTP subsystem: a file-transfer
/// session with no shell channel or PTY. See `spawn_sftp`.
pub struct SftpConnection {
    pub(super) transport: Arc<SharedTransport>,
}

impl SftpConnection {
    /// The transports that could only connect on legacy algorithms.
    pub fn legacy_algorithms(&self) -> &[LegacyAlgorithms] {
        self.transport.legacy_algorithms()
    }

    /// The transport this session runs on; see [`SshConnection::transport`].
    pub fn transport(&self) -> Arc<SharedTransport> {
        self.transport.clone()
    }
}

pub enum SftpConnectOutcome {
    Ready(SftpConnection),
    HostKeyChanged(HostKeyChange),
}

/// Opens an SFTP-only session: the same SSH handshake and authentication as a
/// shell session, but no channel is requested up front. The SFTP subsystem is
/// opened lazily on the first file request, exactly as it is for a shell
/// session's Filer.
pub async fn connect_sftp(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
    request: &Request,
) -> Result<SftpConnectOutcome> {
    match connect_handle(profile, jumps, prompter, Dial::session(), request).await? {
        HandleOutcome::Ready(Transport {
            forwards,
            handle,
            hops,
            legacy,
        }) => Ok(SftpConnectOutcome::Ready(SftpConnection {
            transport: Arc::new(SharedTransport {
                forwards,
                handle: Arc::new(handle),
                hops: Some(hops),
                legacy,
                endpoint: Endpoint::of(profile),
            }),
        })),
        HandleOutcome::HostKeyChanged(change) => Ok(SftpConnectOutcome::HostKeyChanged(change)),
    }
}

/// A file session on a transport that is already authenticated; the SFTP
/// counterpart of [`connect_on`]. The UI offers Duplicate SSH Channel on
/// shell tabs only, so nothing asks for this yet.
pub fn connect_sftp_on(
    transport: Arc<SharedTransport>,
    profile: &SessionProfile,
) -> Result<SftpConnection> {
    transport.carries(profile)?;
    Ok(SftpConnection { transport })
}

/// Drives an SFTP-only session. There is no shell channel to pump, so the loop
/// serves file requests off the SFTP subsystem and periodically checks that the
/// transport is still up. Like the other file backends it does not announce
/// "connected" itself — the frontend records that when `open_session` returns,
/// after the manager has the command handle, so the file pane's first request
/// cannot race the insertion (see `emit_state`).
pub fn spawn_sftp(
    app: AppHandle,
    id: String,
    conn: SftpConnection,
    mut rx: UnboundedReceiver<SessionCommand>,
) {
    tauri::async_runtime::spawn(async move {
        let SftpConnection { transport } = conn;
        let handle = transport.handle.clone();
        let sftp = Arc::new(tokio::sync::Mutex::new(None));
        // Set when the frontend asked for the close; see `emit_state`.
        let mut close_requested = false;

        loop {
            tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Sftp { request, reply }) => {
                            let transport = transport.clone();
                            let slot = sftp.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(browse_sftp(transport, slot, request).await);
                            });
                        }
                        Some(SessionCommand::Close) | None => {
                            close_requested = true;
                            break;
                        }
                        // A file-only session has no terminal, so keyboard
                        // input and resize map to nothing and binary terminal
                        // data is rejected, matching the other file backends.
                        Some(other) => crate::session::reject_unsupported(other, crate::model::SessionKind::Sftp),
                    }
                }
                _ = tokio::time::sleep(SFTP_HEALTH_INTERVAL) => {
                    if handle.is_closed() {
                        break;
                    }
                }
            }
        }

        if !close_requested {
            emit_state(&app, &id, "closed", None);
        }
        // See the shell session's end: the transport may still carry other
        // tabs, and closes itself once none are left.
        drop(handle);
        drop(transport);
    });
}

/// How long the server gets to answer a working-directory query; `grep`
/// over `/proc/*/environ` takes milliseconds, so this only bounds a stuck
/// login shell.
pub(super) const REMOTE_CWD_TIMEOUT: Duration = Duration::from_secs(5);

/// Asks the server for the working directory of the shell's foreground job
/// (see `session::cwd`) over a fresh exec channel of the same connection.
pub(super) async fn remote_cwd(handle: Arc<Handle<Client>>) -> Result<String> {
    let query = async {
        let mut channel = handle.channel_open_session().await?;
        // `sh` takes the script on stdin, so the user's login shell — which
        // sshd runs the command line through, and which may be csh or fish
        // — never has to parse POSIX syntax.
        channel.exec(true, "sh").await?;
        channel
            .data_bytes(crate::session::cwd::REMOTE_CWD_SCRIPT.as_bytes().to_vec())
            .await?;
        channel.eof().await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        // OpenSSH sends exit-status before eof and close, but not every
        // server keeps that order; close (or a dropped channel) is the end.
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, AppError>((stdout, stderr, status))
    };
    let (stdout, stderr, status) = tokio::time::timeout(REMOTE_CWD_TIMEOUT, query)
        .await
        .map_err(|_| {
            AppError::new(format!(
                "the server did not answer the working-directory query within {}s",
                REMOTE_CWD_TIMEOUT.as_secs()
            ))
        })??;
    crate::session::cwd::parse_remote_cwd(
        &String::from_utf8_lossy(&stdout),
        &String::from_utf8_lossy(&stderr),
        status,
    )
}

/// How long one SFTP request may take. Browsing and single-entry operations
/// answer in milliseconds; the deadline only bounds a stuck server.
pub(super) const SFTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

/// A recursive delete is one request that legitimately walks a whole tree, one
/// round trip per entry, so it gets its own, longer deadline. Aborting it at
/// the browsing deadline would leave the tree half deleted.
pub(super) const SFTP_DELETE_TIMEOUT: Duration = Duration::from_secs(300);

/// How long the whole lazy bring-up may take: the channel open, the
/// subsystem answer, and the version exchange. It has to sit above the
/// layers it wraps — a server without the subsystem is refused within
/// [`SFTP_SUBSYSTEM_TIMEOUT`], and one that accepts but never speaks the
/// version gives up on the protocol library's own 10 s request timeout —
/// which the old 10 s cap did not: a server that simply starts its
/// sftp-server slowly (an external subsystem is exec'd through the
/// account's login shell, whose rc files can cost seconds on a loaded
/// machine) had its about-to-arrive version reply cut off, so every Filer
/// request failed as "SFTP initialization timed out". The wait runs off
/// the session's own loop, so a slow start never freezes the terminal.
const SFTP_INIT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn browse_sftp(
    transport: Arc<SharedTransport>,
    slot: Arc<tokio::sync::Mutex<Option<Arc<SftpSession>>>>,
    request: SftpRequest,
) -> Result<SftpResponse> {
    let session = {
        let mut cached = slot.lock().await;
        tokio::time::timeout(
            SFTP_INIT_TIMEOUT,
            ensure_sftp(&transport.handle, &mut cached),
        )
        .await
        .map_err(|_| AppError::new("SFTP initialization timed out"))??
    };
    let deadline = match &request {
        SftpRequest::Remove {
            is_dir: true,
            recursive: true,
            ..
        } => SFTP_DELETE_TIMEOUT,
        _ => SFTP_OPERATION_TIMEOUT,
    };
    let result = tokio::time::timeout(deadline, run_sftp(session.clone(), request))
        .await
        .unwrap_or_else(|_| Err(AppError::timeout("SFTP operation timed out")));
    if result.is_err() {
        let mut cached = slot.lock().await;
        if cached
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            // Next browse operation opens a fresh subsystem. Other requests
            // holding this session can still finish; never replay mutations.
            *cached = None;
        }
    }
    result
}

pub(super) async fn ensure_sftp(
    handle: &Handle<Client>,
    slot: &mut Option<Arc<SftpSession>>,
) -> Result<Arc<SftpSession>> {
    if let Some(existing) = slot {
        return Ok(existing.clone());
    }
    let mut channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    // `request_subsystem` only sends the request. Wait for the server's
    // answer before speaking SFTP: a server without the subsystem refuses at
    // once, while the SFTP handshake would wait out russh-sftp's request
    // timeout for a version that never comes — and this runs inside a shell
    // session's loop, so its terminal froze for that long on every Filer
    // request (found with several tabs on one connection, issue #73).
    let answer = tokio::time::timeout(SFTP_SUBSYSTEM_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return true,
                Some(ChannelMsg::Failure)
                | Some(ChannelMsg::Close)
                | Some(ChannelMsg::Eof)
                | None => return false,
                Some(_) => {}
            }
        }
    })
    .await;
    if answer != Ok(true) {
        // A plain `Channel` is not closed on drop; left open, every retry
        // would leave another session channel on the server.
        let _ = channel.close().await;
        return Err(match answer {
            Err(_) => AppError::timeout(format!(
                "the server did not answer the sftp subsystem request within {} s",
                SFTP_SUBSYSTEM_TIMEOUT.as_secs()
            )),
            _ => AppError::connection_failed("the server does not offer the sftp subsystem"),
        });
    }
    let session = SftpSession::new(channel.into_stream()).await.map_err(|e| {
        AppError::connection_failed(format!("the server refused the sftp subsystem: {e}"))
    })?;
    let session = Arc::new(session);
    *slot = Some(session.clone());
    Ok(session)
}

pub(super) async fn run_sftp(sftp: Arc<SftpSession>, request: SftpRequest) -> Result<SftpResponse> {
    match request {
        SftpRequest::Home => Ok(SftpResponse::Path(sftp.canonicalize(".").await?)),
        SftpRequest::List { path } => {
            let base = match sftp.canonicalize(path.clone()).await {
                Ok(p) => p,
                Err(_) => path,
            };
            let mut entries = Vec::new();
            for entry in sftp.read_dir(base.clone()).await? {
                let meta = entry.metadata();
                let name = entry.file_name();
                entries.push(FileEntry {
                    path: join_remote(&base, &name),
                    name,
                    is_dir: entry.file_type().is_dir(),
                    is_symlink: meta.is_symlink(),
                    size: meta.size.unwrap_or(0),
                    modified: meta.mtime.map(|t| t as i64),
                    permissions: meta.permissions,
                    owner: meta.user.clone(),
                    group: meta.group.clone(),
                });
            }
            sort_entries(&mut entries);
            Ok(SftpResponse::Listing(DirListing {
                path: base,
                entries,
            }))
        }
        SftpRequest::Mkdir { path } => {
            sftp.create_dir(path).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::CreateFile { path } => {
            // EXCLUDE makes the server reject the open when the path exists,
            // so a typo in the name can never truncate a real file.
            let mut file = sftp
                .open_with_flags(
                    path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                )
                .await?;
            file.shutdown().await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Remove {
            path,
            is_dir,
            recursive,
        } => {
            if !is_dir {
                sftp.remove_file(path).await?;
            } else if recursive {
                remove_tree(&sftp, &path).await?;
            } else {
                sftp.remove_dir(path).await?;
            }
            Ok(SftpResponse::Done)
        }
        SftpRequest::Rename { from, to } => {
            sftp.rename(from, to).await?;
            Ok(SftpResponse::Done)
        }
    }
}

/// Removes `root` and everything below it, children first.
///
/// SFTP has no recursive delete, so the walk does it: every folder is listed,
/// files and links are removed with SSH_FXP_REMOVE, and each folder is removed
/// after its children, deepest first. Every folder is LSTAT-ed before it is
/// listed through, and everything the server reports as a link — or as
/// anything but a folder — is removed itself, so a link is never followed into
/// what it points at. LSTAT also covers a server whose READDIR names carry no
/// file type.
///
/// The entry and depth bounds (`MAX_RECURSIVE_DELETE_*`) turn a server whose
/// listing repeats a folder into a clear error instead of a walk that never
/// ends. The first failure aborts and names the entry it happened on: a
/// half-deleted tree is reported as a failure, never as a finished delete.
async fn remove_tree(sftp: &SftpSession, root: &str) -> Result<()> {
    if is_remote_root(root) {
        return Err(AppError::new(format!(
            "refusing to delete {root}: it is the server root"
        )));
    }
    let mut folders: Vec<(String, usize)> = vec![(root.to_string(), 0)];
    let mut files: Vec<String> = Vec::new();
    // Folders that turned out to be links when inspected: they are unlinked
    // with the files and skipped by the folder pass below.
    let mut links: HashSet<String> = HashSet::new();
    let mut visited = HashSet::new();
    let mut index = 0;
    while index < folders.len() {
        let (folder, depth) = folders[index].clone();
        index += 1;
        if !visited.insert(folder.clone()) {
            return Err(AppError::new(format!(
                "cannot delete {root}: the server listed {folder} twice, which looks like a link cycle"
            )));
        }
        if depth > crate::session::MAX_RECURSIVE_DELETE_DEPTH {
            return Err(AppError::new(format!(
                "cannot delete {root}: it is nested more than {} folders deep",
                crate::session::MAX_RECURSIVE_DELETE_DEPTH
            )));
        }
        // The entry's own attributes are checked before anything below it is
        // read: `is_dir` came from a listing that may be stale or that carried
        // no type at all, and a link must never be walked through.
        let metadata = sftp
            .symlink_metadata(folder.clone())
            .await
            .map_err(|error| AppError::new(format!("cannot read {folder}: {error}")))?;
        if !metadata.is_dir() || metadata.is_symlink() {
            files.push(folder.clone());
            links.insert(folder);
            continue;
        }
        let entries = sftp
            .read_dir(folder.clone())
            .await
            .map_err(|error| AppError::new(format!("cannot list {folder}: {error}")))?;
        for entry in entries {
            // A name is what the path below is built from, so one that could
            // step out of the tree (`..`, `a/b`) is refused: the delete only
            // ever covers what the user selected.
            let name = entry.file_name();
            if !crate::session::is_plain_name(&name) {
                return Err(AppError::new(format!(
                    "cannot delete {root}: the server listed an unusable name ({name})"
                )));
            }
            let path = entry.path();
            let metadata = entry.metadata();
            if metadata.is_dir() && !metadata.is_symlink() {
                folders.push((path, depth + 1));
            } else {
                files.push(path);
            }
            if files.len() + folders.len() > crate::session::MAX_RECURSIVE_DELETE_ENTRIES {
                return Err(AppError::new(format!(
                    "cannot delete {root}: it holds more than {} entries",
                    crate::session::MAX_RECURSIVE_DELETE_ENTRIES
                )));
            }
        }
    }

    for file in files {
        sftp.remove_file(file.clone())
            .await
            .map_err(|error| crate::session::delete_failed(error.into(), &file))?;
    }
    for (folder, _) in folders.iter().rev() {
        if links.contains(folder) {
            continue;
        }
        sftp.remove_dir(folder.clone())
            .await
            .map_err(|error| crate::session::delete_failed(error.into(), folder))?;
    }
    Ok(())
}

/// A path naming the server's root, or the current directory itself. The Filer
/// offers none of these for deletion, but a recursive delete refuses them
/// however it is called.
fn is_remote_root(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    trimmed.is_empty() || matches!(trimmed, "." | "..")
}

pub(super) fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}
