use super::*;

/// Prepares an editable local copy. A reused path is already watched and must
/// not be downloaded over or watched again.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn remote_edit_path(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    name: String,
) -> Result<crate::remote_edit::RemoteEditPath> {
    state.remote_edits.local_path(&id, &remote, &name)
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
