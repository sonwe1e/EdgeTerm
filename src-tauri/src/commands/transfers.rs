use super::*;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_home(state: State<'_, AppState>, id: String) -> Result<String> {
    expect_path(state.sessions.sftp(&id, SftpRequest::Home).await?)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> Result<DirListing> {
    expect_listing(state.sessions.sftp(&id, SftpRequest::List { path }).await?)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Mkdir { path })
        .await?;
    Ok(())
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_create_file(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::CreateFile { path })
        .await?;
    Ok(())
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Remove { path, is_dir })
        .await?;
    Ok(())
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Rename { from, to })
        .await?;
    Ok(())
}

/// Interrupts pending I/O and asks the background worker to remove its owned
/// partial files. Existing destination files are preserved.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn cancel_transfer(state: State<'_, AppState>, transfer: String) {
    state.file_transfers.cancel(&transfer);
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_file_transfers(state: State<'_, AppState>) -> Vec<crate::file_transfer::Snapshot> {
    state.file_transfers.snapshots()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn control_file_transfer(
    state: State<'_, AppState>,
    transfer: String,
    action: String,
) -> Result<()> {
    state.file_transfers.control(&transfer, &action)
}

/// `transfer` is the id `cancel_transfer` can name while the copy runs;
/// without one the transfer gets a generated id and can still be controlled
/// in the transfer center.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn transfer_files(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    items: Vec<crate::file_transfer::Item>,
    transfer: Option<String>,
    options: Option<crate::file_transfer::Options>,
    on_progress: Channel<TransferProgress>,
) -> Result<()> {
    let job = state.file_transfers.start(
        Some(app),
        id,
        items,
        transfer,
        options.unwrap_or_default(),
        on_progress,
    )?;
    crate::file_transfer::wait(&job).await
}

/// Journals of transfers interrupted by a restart, for the recovery list.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_recoverable_transfers(
    state: State<'_, AppState>,
) -> Vec<crate::file_transfer::Recoverable> {
    state.file_transfers.discover()
}

/// Resumes an interrupted transfer on the session the user still has open
/// to the same endpoint. SFTP reuses its authenticated SSH transport without
/// another authentication prompt; FTP dials separate transfer connections
/// using the open session's profile credentials.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn recover_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer: String,
    on_progress: Channel<TransferProgress>,
) -> Result<()> {
    let journal = state.file_transfers.read_persisted(&transfer)?;
    // The human-readable target for messages; the endpoint key stays the
    // machine's only matching truth.
    let readable = match (&journal.username, &journal.host, journal.port) {
        (Some(user), Some(host), Some(port)) => format!("{user}@{host}:{port}"),
        (Some(user), Some(host), None) => format!("{user}@{host}"),
        (_, Some(host), Some(port)) => format!("{host}:{port}"),
        (_, Some(host), None) => host.clone(),
        _ => journal.endpoint.clone(),
    };
    let sessions = state.sessions.list();
    // The endpoint key carries the protocol prefix, so one comparison
    // covers kind, host, port, user and jump chain at once.
    let mut transport_down = None;
    for info in sessions {
        let Some(profile) = state.file_transfers.profile_of(&info.id) else {
            continue;
        };
        if crate::file_transfer::endpoint_of(&profile) != journal.endpoint {
            continue;
        }
        // SFTP journals ride a live shared transport; anything else would
        // mean dialling and authenticating, which recovery never does.
        let transport = if journal.kind == "ftp" {
            None
        } else {
            match state.ssh_transports.get(&info.id) {
                Some(transport) => Some(transport),
                None => {
                    transport_down = Some(
                        "a session matches but its connection is down; reconnect it first"
                            .to_string(),
                    );
                    continue;
                }
            }
        };
        let jumps = state.store.jump_chain(&profile)?;
        state.file_transfers.adopt(
            Some(app),
            journal,
            info.id,
            profile,
            jumps,
            transport,
            on_progress,
        )?;
        return Ok(());
    }
    Err(AppError::new(match transport_down {
        Some(reason) => format!("cannot recover this transfer: {reason}"),
        None => format!("open a session to {readable} before resuming this transfer"),
    }))
}

/// Deletes an interrupted transfer's journal. Nothing remote is touched:
/// partial files stay where the crash left them, for manual cleanup.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn discard_recoverable_transfer(state: State<'_, AppState>, transfer: String) -> Result<()> {
    state.file_transfers.discard_persisted(&transfer)
}
