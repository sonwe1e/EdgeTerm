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

pub(super) async fn browse_sftp(
    transport: Arc<SharedTransport>,
    slot: Arc<tokio::sync::Mutex<Option<Arc<SftpSession>>>>,
    request: SftpRequest,
) -> Result<SftpResponse> {
    let session = {
        let mut cached = slot.lock().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            ensure_sftp(&transport.handle, &mut cached),
        )
        .await
        .map_err(|_| AppError::new("SFTP initialization timed out"))??
    };
    let result = tokio::time::timeout(Duration::from_secs(30), run_sftp(session.clone(), request))
        .await
        .unwrap_or_else(|_| Err(AppError::new("SFTP operation timed out")));
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
        SftpRequest::Remove { path, is_dir } => {
            if is_dir {
                sftp.remove_dir(path).await?;
            } else {
                sftp.remove_file(path).await?;
            }
            Ok(SftpResponse::Done)
        }
        SftpRequest::Rename { from, to } => {
            sftp.rename(from, to).await?;
            Ok(SftpResponse::Done)
        }
    }
}

pub(super) fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}
