use super::*;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_home() -> String {
    fs_local::home()
}

/// Where the session's shell is right now, for the Filer's "Reveal Working
/// Directory" action; see `session::cwd`.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn session_cwd(state: State<'_, AppState>, id: String) -> Result<String> {
    state.sessions.query_cwd(&id).await
}

/// This machine's host name, so the frontend can tell a local shell's OSC 7
/// directory report from one a remote shell sent through a hand-typed ssh.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_hostname() -> String {
    session::cwd::local_hostname()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn local_list(path: String) -> Result<DirListing> {
    tokio::task::spawn_blocking(move || fs_local::list(&path))
        .await
        .map_err(|error| AppError::new(format!("local listing task failed: {error}")))?
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_parent(path: String) -> String {
    fs_local::parent_of(&path)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_mkdir(path: String) -> Result<()> {
    fs_local::mkdir(&path)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_create_file(path: String) -> Result<()> {
    fs_local::create_file(&path)
}

/// Opens a local file with the system default application, or with `with`
/// (a macOS `.app` bundle, a Windows executable or a Unix program path) when
/// given. Errors only cover launching; whatever the program does afterwards is
/// its own business.
#[tauri::command]
pub fn open_local_path(path: String, with: Option<String>) -> Result<()> {
    tauri_plugin_opener::open_path(&path, with.as_deref()).map_err(err)
}

/// Copies a dropped file or folder into the folder the Filer is showing, for
/// a drop on a Filer that has no remote session to upload to. Runs off the
/// async runtime: the walk and the copies are blocking file system work.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn local_copy_into(
    source: String,
    destination: String,
    on_progress: Channel<TransferProgress>,
) -> Result<LocalCopySummary> {
    tokio::task::spawn_blocking(move || fs_local::copy_into(&source, &destination, &on_progress))
        .await
        .map_err(err)?
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn local_rename(from: String, to: String) -> Result<()> {
    fs_local::rename(&from, &to)
}

/// Deletes one local entry. `recursive` is set only after the user confirmed
/// that a folder's contents go with it; moving the walk off the async runtime
/// keeps a large tree from stalling the interface.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn local_remove(path: String, is_dir: bool, recursive: bool) -> Result<()> {
    tokio::task::spawn_blocking(move || fs_local::remove(&path, is_dir, recursive))
        .await
        .map_err(|error| AppError::new(format!("local delete task failed: {error}")))?
}
