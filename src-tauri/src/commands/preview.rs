use super::*;

/// Opens a read-only preview of one remote HTML report. `path` is the report
/// itself: its directory becomes the only tree the preview can read and the
/// returned URL names the file, so relative resources beside it load too.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn preview_start(
    state: State<'_, AppState>,
    previews: State<'_, crate::preview::Previews>,
    session_id: String,
    path: String,
) -> Result<crate::preview::PreviewSession> {
    let profile = state
        .file_transfers
        .profile_of(&session_id)
        .ok_or_else(|| AppError::new("connect to the server before previewing a report"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::invalid_input(
            "report preview requires an SSH or SFTP session",
        ));
    }
    let transport = state
        .ssh_transports
        .get(&session_id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    let row = previews.start(&session_id, transport, &path).await?;
    // If the owner closed between validation and registration, cancel its new
    // preview instead of leaving a listener with no session behind it.
    if state.file_transfers.profile_of(&session_id).is_none() {
        previews.close_session(&session_id);
    }
    Ok(row)
}

/// Stops one preview and waits for its port to be released.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn preview_stop(previews: State<'_, crate::preview::Previews>, id: String) -> Result<()> {
    previews.stop(&id).await
}

/// The previews still serving, for a panel that wants to reopen or stop one.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn preview_list(
    previews: State<'_, crate::preview::Previews>,
) -> Vec<crate::preview::PreviewSession> {
    previews.list()
}
