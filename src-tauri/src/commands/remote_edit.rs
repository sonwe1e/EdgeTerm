use super::*;

/// Where a remote file opened in a local application is downloaded to; the
/// same place again while the file is still being watched. See
/// `remote_edit::RemoteEdits::local_path`.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn remote_edit_path(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    name: String,
) -> Result<String> {
    let path = state.remote_edits.local_path(&id, &remote, &name)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Starts sending `local` back to `remote` on session `id` whenever it
/// changes. Called right after the download, so the copy is the baseline.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn watch_remote_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> Result<()> {
    state
        .remote_edits
        .watch(app, id, std::path::PathBuf::from(local), remote)
}

/// Stops watching every file opened from session `id` and removes the synced
/// copies; for when its tab is closed for good (a disconnect keeps the
/// watchers, see `RemoteEdits`).
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn stop_remote_edits(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.remote_edits.stop_session(&app, &id);
}
