use super::*;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn compare_files(
    state: State<'_, AppState>,
    id: String,
    request_id: String,
    local: String,
    remote: String,
) -> Result<crate::file_diff::Comparison> {
    // Register before fetching the profile: close_session can then either
    // cancel this request or remove the profile before any reader starts.
    let request = state.file_diffs.begin(&id, &request_id)?;
    let profile = state
        .file_transfers
        .profile_of(&id)
        .ok_or_else(|| AppError::new("connect to the file server before comparing"))?;
    if !matches!(
        profile.kind,
        SessionKind::Ssh | SessionKind::Sftp | SessionKind::Ftp
    ) {
        return Err(AppError::new("file comparison requires SSH, SFTP or FTP"));
    }
    let transport = state.ssh_transports.get(&id);
    crate::file_diff::compare(request, profile, transport, local, remote).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn cancel_file_diff(state: State<'_, AppState>, request_id: String) {
    state.file_diffs.cancel(&request_id);
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn sample_resources(
    state: State<'_, AppState>,
    id: String,
    request_id: String,
) -> Result<crate::resource_monitor::Metrics> {
    let profile = state
        .file_transfers
        .profile_of(&id)
        .ok_or_else(|| AppError::new("connect to SSH before monitoring"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::new("resource monitoring requires SSH"));
    }
    let request = state.resource_monitor.begin(
        &id,
        &request_id,
        crate::file_transfer::endpoint_of(&profile),
    )?;
    if state.file_transfers.profile_of(&id).is_none() {
        return Err(AppError::new("SSH session closed"));
    }
    let transport = state
        .ssh_transports
        .get(&id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    state.resource_monitor.sample(request, transport).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn cancel_resource_sample(state: State<'_, AppState>, request_id: String) {
    state.resource_monitor.cancel(&request_id);
}
