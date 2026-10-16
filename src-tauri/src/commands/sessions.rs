use super::*;
use crate::diagnostics::Request;

/// The SSH connection a new session asked to share, when the session named
/// still has one and it is still up. `None` means the session opens its own:
/// a connection that went down in the meantime has nothing left to share.
pub(super) fn reuse(
    state: &AppState,
    session_id: &Option<String>,
) -> Option<Arc<session::ssh::SharedTransport>> {
    state.ssh_transports.get(session_id.as_deref()?)
}

#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: SessionProfile,
    // The frontend mints the id so it can have a terminal listening before the
    // first byte of output arrives.
    session_id: String,
    // The session whose SSH connection this one should run on instead of
    // dialling and authenticating its own — what Duplicate SSH Channel asks
    // for, so a server behind MFA is answered once per connection rather than
    // once per tab. A connection that has gone down in
    // the meantime is simply dialled again.
    reuse_session_id: Option<String>,
    auto_reuse: Option<bool>,
    // The raw channel this session's terminal bytes stream out on, opened by
    // the same invoke that opens the session; see OutputPump. File sessions
    // (FTP, SFTP) never write to it.
    on_output: Channel<InvokeResponseBody>,
    output_token: String,
) -> Result<OpenSessionOutcome> {
    let id = if session_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        session_id
    };
    // One request per open: its id ties the dial, authentication and channel
    // stages together in the diagnostics log, and ends in the outcome.
    let request = Request::begin("open_session").with_session(&id);
    let result = open_session_inner(
        app,
        &state,
        profile,
        id,
        reuse_session_id,
        auto_reuse,
        on_output,
        output_token,
        &request,
    )
    .await;
    request.finish(result)
}

/// The body of `open_session`, under the diagnostics request bracketing it.
#[allow(clippy::too_many_arguments)]
async fn open_session_inner(
    app: AppHandle,
    state: &AppState,
    profile: SessionProfile,
    id: String,
    reuse_session_id: Option<String>,
    auto_reuse: Option<bool>,
    on_output: Channel<InvokeResponseBody>,
    output_token: String,
    request: &Request,
) -> Result<OpenSessionOutcome> {
    // A profile may arrive by id (from the tree) or inline (quick connect).
    let profile = if !profile.id.is_empty() {
        match state.store.get(&profile.id)? {
            // Prefer a secret supplied by the dialog over the saved credential.
            Some(saved) => merge_secrets(saved, profile),
            None => profile,
        }
    } else {
        profile
    };

    let (tx, rx) = mpsc::unbounded_channel();
    // Reconnects reuse the tab id, but must retire the old generation even
    // when it ended naturally with some final ACKs still in flight.
    state.outputs.close_session(&id);
    let on_output = state.outputs.open(&id, output_token, on_output)?;
    let mut info = session::make_info(&id, &profile);
    // The recording a terminal profile asked for. Opened right before the
    // session starts producing output — after an SSH handshake, so a
    // refused key or a wrong password leaves no empty file behind.
    let start_recording = |info: &mut SessionInfo| -> Result<Option<Recorder>> {
        if !profile.record {
            return Ok(None);
        }
        let recorder = Recorder::start(
            &id,
            &profile,
            recording::report_to_ui(app.clone(), id.clone()),
        )?;
        info.recording = Some(recorder.path().display().to_string());
        Ok(Some(recorder))
    };

    let owner_thread = match profile.kind {
        SessionKind::Ftp => {
            let connect_profile = profile.clone();
            let conn = tokio::task::spawn_blocking(move || session::ftp::connect(&connect_profile))
                .await
                .map_err(|e| AppError::new(format!("ftp connection task failed: {e}")))??;
            session::ftp::spawn(app.clone(), id.clone(), conn, rx)?;
            None
        }
        SessionKind::Local => {
            let recorder = start_recording(&mut info)?;
            session::local::spawn(app.clone(), id.clone(), &profile, rx, recorder, on_output)?;
            None
        }
        SessionKind::Serial => {
            let recorder = start_recording(&mut info)?;
            Some(session::serial::spawn(
                app.clone(),
                id.clone(),
                &profile,
                rx,
                recorder,
                on_output,
            )?)
        }
        SessionKind::Telnet => {
            let stream = session::telnet::connect(&profile).await?;
            let recorder = start_recording(&mut info)?;
            session::telnet::spawn(
                app.clone(),
                id.clone(),
                stream,
                profile.port.unwrap_or(session::telnet::DEFAULT_PORT),
                rx,
                recorder,
                session::telnet::AutoLogin::new(&profile, std::time::Instant::now()),
                on_output,
            );
            None
        }
        SessionKind::Ssh => {
            // A connection to share, when one was asked for and is still up.
            // A live one that will not take another channel is an error, not
            // a cue to log in again: the user asked for no second login, and
            // behind MFA a surprise login costs another code.
            let shared = match reuse(state, &reuse_session_id) {
                Some(transport) => {
                    request.info(
                        "reuse",
                        "opening another shell channel on the shared connection",
                    );
                    Some(
                        session::ssh::connect_on(transport, &profile)
                            .await
                            .map_err(|e| {
                                AppError::new(format!(
                                    "the server refused another channel on this connection \
                                     (sshd limits them with MaxSessions, 10 by default): {e}"
                                ))
                            })?,
                    )
                }
                None => None,
            };
            info.shared_connection = shared.is_some();
            let conn = match shared {
                Some(conn) => conn,
                None => {
                    let prompter = AuthPrompter::ui(&app, &state.auth_prompts, &id);
                    if auto_reuse.unwrap_or(true) {
                        let jumps = state.store.jump_chain(&profile)?;
                        match state
                            .ssh_transports
                            .automatic
                            .connect(&profile, &jumps, &prompter, request)
                            .await?
                        {
                            session::reuse::TransportOutcome::Ready(transport, reused) => {
                                info.shared_connection = reused;
                                session::ssh::connect_on(transport, &profile).await?
                            }
                            session::reuse::TransportOutcome::HostKeyChanged(change) => {
                                return Ok(OpenSessionOutcome::HostKeyChanged { change })
                            }
                        }
                    } else {
                        match session::ssh::connect(
                            &profile,
                            &state.store.jump_chain(&profile)?,
                            &prompter,
                            request,
                        )
                        .await?
                        {
                            ConnectOutcome::Ready(conn) => conn,
                            // Nothing was opened; the user decides whether to trust
                            // the new key and the frontend retries with the same
                            // session id.
                            ConnectOutcome::HostKeyChanged(change) => {
                                return Ok(OpenSessionOutcome::HostKeyChanged { change });
                            }
                        }
                    }
                }
            };
            info.legacy_algorithms = conn.legacy_algorithms().to_vec();
            state.ssh_transports.register(&id, &conn.transport());
            let recorder = start_recording(&mut info)?;
            session::ssh::spawn(app.clone(), id.clone(), conn, rx, recorder, on_output);
            None
        }
        SessionKind::Sftp => {
            let shared = match reuse(state, &reuse_session_id) {
                Some(transport) => {
                    request.info(
                        "reuse",
                        "opening another sftp session on the shared connection",
                    );
                    Some(session::ssh::connect_sftp_on(transport, &profile)?)
                }
                None => None,
            };
            info.shared_connection = shared.is_some();
            let conn = match shared {
                Some(conn) => conn,
                None => {
                    let prompter = AuthPrompter::ui(&app, &state.auth_prompts, &id);
                    if auto_reuse.unwrap_or(true) {
                        let jumps = state.store.jump_chain(&profile)?;
                        match state
                            .ssh_transports
                            .automatic
                            .connect(&profile, &jumps, &prompter, request)
                            .await?
                        {
                            session::reuse::TransportOutcome::Ready(transport, reused) => {
                                info.shared_connection = reused;
                                session::ssh::connect_sftp_on(transport, &profile)?
                            }
                            session::reuse::TransportOutcome::HostKeyChanged(change) => {
                                return Ok(OpenSessionOutcome::HostKeyChanged { change })
                            }
                        }
                    } else {
                        match session::ssh::connect_sftp(
                            &profile,
                            &state.store.jump_chain(&profile)?,
                            &prompter,
                            request,
                        )
                        .await?
                        {
                            SftpConnectOutcome::Ready(conn) => conn,
                            // Same host-key decision as a shell session on the
                            // same transport.
                            SftpConnectOutcome::HostKeyChanged(change) => {
                                return Ok(OpenSessionOutcome::HostKeyChanged { change });
                            }
                        }
                    }
                }
            };
            info.legacy_algorithms = conn.legacy_algorithms().to_vec();
            state.ssh_transports.register(&id, &conn.transport());
            session::ssh::spawn_sftp(app.clone(), id.clone(), conn, rx);
            None
        }
    };

    state.file_transfers.remember(&id, &profile);
    state.sessions.insert(SessionHandle {
        info: info.clone(),
        tx,
        encoding: session::encoding::terminal_encoding(&profile),
        owner_thread,
    });
    Ok(OpenSessionOutcome::Connected { info })
}

/// Record the key a host now presents, replacing every `known_hosts` entry
/// the file held for it, after the user accepted a reported `HostKeyChange`.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn accept_host_key(host: String, port: u16, public_key: String) -> Result<()> {
    session::ssh::accept_host_key(&host, port, &public_key)
}

/// Answers one round of an SSH server's keyboard-interactive challenge (an
/// MFA code, a push confirmation, a menu choice) for the connection waiting
/// on `id`. `responses` is `None` when the user cancelled. The answers are
/// used once and never stored.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn answer_auth_prompt(
    state: State<'_, AppState>,
    id: String,
    responses: Option<Vec<String>>,
) -> Result<()> {
    state.auth_prompts.answer(&id, responses)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<()> {
    state.file_transfers.forget(&id);
    state.file_diffs.close_session(&id);
    state.resource_monitor.close_session(&id);
    state.port_forwards.close_session(&id);
    state.outputs.close_session(&id);
    // Nothing new may be opened on this session's connection once it is
    // closing; whether the connection itself goes down depends on the other
    // sessions sharing it (see `session::ssh::SharedTransport`).
    state.ssh_transports.forget(&id);
    if let Some(handle) = state.sessions.remove(&id) {
        let _ = handle.tx.send(SessionCommand::Close);
        if let Some(owner_thread) = handle.owner_thread {
            owner_thread.join().map_err(|_| {
                AppError::new(format!("serial session {id} panicked while closing"))
            })?;
        }
    }
    Ok(())
}

/// Consumption acknowledgements must bypass a potentially busy transport's
/// command queue. Tokens distinguish reconnects that reuse a tab/session id.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn acknowledge_session_output(state: State<'_, AppState>, token: String, consumed: u64) {
    state.outputs.acknowledge(&token, consumed);
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.sessions.list()
}

/// Where a profile's recordings go when it names no folder of its own; the
/// session dialog shows it as the folder field's placeholder.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn default_recording_dir() -> String {
    recording::default_dir().display().to_string()
}

/// The font families installed on this machine; see `fonts`. Reading the
/// font directories takes a moment, so it runs off the async runtime.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn list_system_fonts() -> Vec<FontFamily> {
    tauri::async_runtime::spawn_blocking(fonts::system_font_families)
        .await
        .unwrap_or_default()
}

/// The family the Linux terminal stack leads with; see
/// `fonts::system_monospace_family`. `fc-match` is a process, so it runs off
/// the async runtime too.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn system_monospace_family() -> Option<String> {
    tauri::async_runtime::spawn_blocking(fonts::system_monospace_family)
        .await
        .ok()
        .flatten()
}
